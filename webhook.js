// Vercel Function: recebe as notificações Webhook do Mercado Pago sobre
// assinaturas (tópico "subscription_preapproval") e atualiza o plano do
// usuário no Supabase.
//
// Variáveis de ambiente necessárias (configurar no painel do Vercel):
//   MP_ACCESS_TOKEN            -> mesmo token usado em criar-assinatura.js
//   MP_WEBHOOK_SECRET          -> "assinatura secreta" gerada em
//                                 Mercado Pago > Suas integrações > Webhooks
//                                 (é DIFERENTE do access token!)
//   SUPABASE_SERVICE_ROLE_KEY  -> chave service_role do Supabase (Project
//                                 Settings > API). NUNCA usar no front-end.
//   SUPABASE_URL               -> URL do projeto Supabase (não é secreta,
//                                 mas fica aqui como env var por organização)
//
// Referência oficial de validação de assinatura:
// https://www.mercadopago.com.br/developers/pt/docs/subscriptions/additional-content/your-integrations/notifications/webhooks

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jowomcluexjbibioytuw.supabase.co';

function validarAssinatura(xSignature, xRequestId, dataId, secret) {
    if (!xSignature || !secret) return false;
    let ts = null, v1 = null;
    xSignature.split(',').forEach(parte => {
        const [chave, valor] = parte.split('=').map(s => s && s.trim());
        if (chave === 'ts') ts = valor;
        if (chave === 'v1') v1 = valor;
    });
    if (!ts || !v1) return false;

    // Monta o manifest exatamente como a documentação do MP exige.
    // Se algum valor não existir na notificação, ele é removido do manifest.
    const partes = [];
    if (dataId) partes.push(`id:${String(dataId).toLowerCase()}`);
    if (xRequestId) partes.push(`request-id:${xRequestId}`);
    partes.push(`ts:${ts}`);
    const manifest = partes.join(';') + ';';

    const calculado = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
    // Comparação em tempo constante pra evitar timing attack
    const a = Buffer.from(calculado, 'utf8');
    const b = Buffer.from(v1, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function mapearStatus(statusMp) {
    // Status possíveis do preapproval no Mercado Pago:
    // 'pending' (aguardando 1ª cobrança), 'authorized' (ativo), 'paused', 'cancelled'
    if (statusMp === 'authorized') return 'ativo';
    if (statusMp === 'paused') return 'atrasado';
    if (statusMp === 'cancelled') return 'cancelado';
    return 'atrasado'; // 'pending' ou desconhecido: ainda não libera acesso
}

module.exports = async (req, res) => {
    // O Mercado Pago espera 200/201 em até 22s. Sempre respondemos rápido,
    // mesmo em caso de erro nosso (senão ele fica reenviando a cada 15min).
    if (req.method !== 'POST') {
        res.status(200).json({ ok: true }); // ignora GET/HEAD de teste do painel
        return;
    }

    try {
        const dataId = (req.query && req.query['data.id']) || req.body?.data?.id;
        const xSignature = req.headers['x-signature'];
        const xRequestId = req.headers['x-request-id'];
        const secret = process.env.MP_WEBHOOK_SECRET;

        if (!secret) {
            console.error('MP_WEBHOOK_SECRET não configurado — recusando notificação por segurança.');
            res.status(200).json({ ok: true }); // 200 pra não gerar retry infinito, mas não processa nada
            return;
        }

        const assinaturaValida = validarAssinatura(xSignature, xRequestId, dataId, secret);
        if (!assinaturaValida) {
            console.warn('Webhook Mercado Pago com assinatura inválida — ignorado.');
            res.status(401).json({ error: 'Assinatura inválida' });
            return;
        }

        const topic = req.body?.type || req.query?.type;
        if (topic !== 'subscription_preapproval' || !dataId) {
            // Não é um evento de assinatura (ou não trouxe o id) — confirma recebimento e ignora.
            res.status(200).json({ ok: true });
            return;
        }

        const accessToken = process.env.MP_ACCESS_TOKEN;
        const mpRes = await fetch(`https://api.mercadopago.com/preapproval/${dataId}`, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        const preapproval = await mpRes.json();

        if (!mpRes.ok || !preapproval?.external_reference) {
            console.error('Não foi possível obter detalhes do preapproval:', preapproval);
            res.status(200).json({ ok: true }); // confirma recebimento mesmo assim (evita retry infinito)
            return;
        }

        const userId = preapproval.external_reference; // definido em criar-assinatura.js
        const planoStatus = mapearStatus(preapproval.status);

        const supabaseAdmin = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
        const { error } = await supabaseAdmin.from('perfis').update({
            plano: 'pro',
            plano_status: planoStatus,
            mp_preapproval_id: preapproval.id,
            mp_proximo_vencimento: preapproval.next_payment_date || null
        }).eq('user_id', userId);

        if (error) {
            console.error('Erro ao atualizar perfil no Supabase:', error);
            res.status(200).json({ ok: true }); // MP não deve ficar retentando por erro nosso interno
            return;
        }

        console.log(`✓ Assinatura ${preapproval.id} do usuário ${userId}: status MP=${preapproval.status} -> ${planoStatus}`);
        res.status(200).json({ ok: true });
    } catch (e) {
        console.error('Erro inesperado no webhook Mercado Pago:', e);
        // Mesmo em erro interno, respondemos 200 pra não empilhar retries indefinidamente;
        // o erro fica logado no Vercel pra investigação manual.
        res.status(200).json({ ok: true });
    }
};
