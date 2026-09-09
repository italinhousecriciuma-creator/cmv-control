// Vercel Function: recebe as notificações Webhook do Mercado Pago sobre
// assinaturas e pagamentos, e atualiza o plano do usuário no Supabase.
//
// Trata DOIS tópicos:
//   - subscription_preapproval  -> criação/atualização da assinatura (status authorized/paused/cancelled)
//   - payment                   -> cada cobrança efetuada; usamos pra confirmar o pagamento aprovado
//
// Variáveis de ambiente necessárias (configurar no painel do Vercel):
//   MP_ACCESS_TOKEN            -> mesmo token usado em criar-assinatura.js
//   MP_WEBHOOK_SECRET          -> "assinatura secreta" gerada em
//                                 Mercado Pago > Suas integrações > Webhooks
//                                 (é DIFERENTE do access token!)
//   SUPABASE_SERVICE_ROLE_KEY  -> chave service_role do Supabase (Project Settings > API)
//   SUPABASE_URL               -> URL do projeto Supabase
//
// Referência oficial de validação de assinatura:
// https://www.mercadopago.com.br/developers/pt/docs/subscriptions/additional-content/your-integrations/notifications/webhooks

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jowomcluexjbibioytuw.supabase.co';

// Liga/desliga logs verbosos. Deixe true enquanto testa; pode trocar pra false depois.
const DEBUG = true;
function log(...args) { if (DEBUG) console.log('[MP-WEBHOOK]', ...args); }

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
    const a = Buffer.from(calculado, 'utf8');
    const b = Buffer.from(v1, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function mapearStatus(statusMp) {
    // 'pending' (aguardando 1ª cobrança), 'authorized' (ativo), 'paused', 'cancelled'
    if (statusMp === 'authorized') return 'ativo';
    if (statusMp === 'paused') return 'atrasado';
    if (statusMp === 'cancelled') return 'cancelado';
    return 'atrasado'; // 'pending' ou desconhecido: ainda não libera acesso
}

// Extrai o data.id de qualquer formato que o MP possa mandar.
function extrairDataId(req) {
    if (req.query && req.query['data.id']) return req.query['data.id'];
    if (req.body && req.body.data && req.body.data.id) return req.body.data.id;
    if (req.body && req.body.id && (req.body.type || req.body.topic)) return req.body.id;
    if (req.body && req.body.resource) {
        const r = String(req.body.resource);
        const m = r.match(/(\d+)\s*$/);
        if (m) return m[1];
        return r;
    }
    return null;
}

function extrairTopic(req) {
    return (req.body && (req.body.type || req.body.topic))
        || (req.query && (req.query.type || req.query.topic))
        || null;
}

// Atualiza o perfil no Supabase a partir de um preapproval (assinatura).
async function aplicarPreapproval(dataId, accessToken) {
    const mpRes = await fetch(`https://api.mercadopago.com/preapproval/${dataId}`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const preapproval = await mpRes.json();

    if (!mpRes.ok || !preapproval || !preapproval.external_reference) {
        console.error('[MP-WEBHOOK] Não foi possível obter o preapproval:', mpRes.status, preapproval);
        return { ok: false };
    }

    const userId = preapproval.external_reference; // definido em criar-assinatura.js
    const planoStatus = mapearStatus(preapproval.status);
    log(`preapproval ${preapproval.id} | user=${userId} | status MP=${preapproval.status} -> ${planoStatus}`);

    const supabaseAdmin = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { error } = await supabaseAdmin.from('perfis').update({
        plano: 'pro',
        plano_status: planoStatus,
        mp_preapproval_id: preapproval.id,
        mp_proximo_vencimento: preapproval.next_payment_date || null
    }).eq('user_id', userId);

    if (error) {
        console.error('[MP-WEBHOOK] Erro ao atualizar perfil no Supabase:', error);
        return { ok: false };
    }
    log(`OK Perfil atualizado: user=${userId} plano_status=${planoStatus}`);
    return { ok: true };
}

// Trata notificação de pagamento: busca o pagamento e, se tiver o id da assinatura,
// reaplica o status da assinatura (garante que o Pro seja liberado no aprovado).
async function aplicarPayment(dataId, accessToken) {
    const payRes = await fetch(`https://api.mercadopago.com/v1/payments/${dataId}`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const pagamento = await payRes.json();

    if (!payRes.ok) {
        console.error('[MP-WEBHOOK] Não foi possível obter o pagamento:', payRes.status, pagamento);
        return { ok: false };
    }

    const status = pagamento.status; // approved / rejected / pending / etc.
    const preapprovalId = (pagamento.metadata && pagamento.metadata.preapproval_id)
        || (pagamento.point_of_interaction
            && pagamento.point_of_interaction.transaction_data
            && pagamento.point_of_interaction.transaction_data.subscription_id)
        || null;
    log(`payment ${dataId} | status=${status} | preapproval_id=${preapprovalId || '(nao veio)'}`);

    if (preapprovalId) {
        return await aplicarPreapproval(preapprovalId, accessToken);
    }

    log('payment sem preapproval_id — ignorado (o evento de assinatura cuida da liberacao).');
    return { ok: true };
}

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        res.status(200).json({ ok: true }); // GET/HEAD de teste do painel
        return;
    }

    try {
        const dataId = extrairDataId(req);
        const topic = extrairTopic(req);
        const xSignature = req.headers['x-signature'];
        const xRequestId = req.headers['x-request-id'];
        const secret = process.env.MP_WEBHOOK_SECRET;

        log(`Recebido: topic=${topic || '(vazio)'} data.id=${dataId || '(vazio)'}`);

        if (!secret) {
            console.error('[MP-WEBHOOK] MP_WEBHOOK_SECRET nao configurado — recusando por seguranca.');
            res.status(200).json({ ok: true });
            return;
        }

        const assinaturaValida = validarAssinatura(xSignature, xRequestId, dataId, secret);
        if (!assinaturaValida) {
            console.warn('[MP-WEBHOOK] Assinatura x-signature invalida — ignorado. (Se aparecer muito, o MP_WEBHOOK_SECRET no Vercel provavelmente esta errado.)');
            res.status(401).json({ error: 'Assinatura inválida' });
            return;
        }

        if (!dataId) {
            log('Sem data.id — nada a processar.');
            res.status(200).json({ ok: true });
            return;
        }

        const accessToken = process.env.MP_ACCESS_TOKEN;

        if (topic === 'subscription_preapproval') {
            await aplicarPreapproval(dataId, accessToken);
        } else if (topic === 'subscription_authorized_payment' || topic === 'payment') {
            await aplicarPayment(dataId, accessToken);
        } else {
            log(`Topico nao tratado: "${topic}" — confirmado e ignorado.`);
        }

        res.status(200).json({ ok: true });
    } catch (e) {
        console.error('[MP-WEBHOOK] Erro inesperado:', e);
        res.status(200).json({ ok: true });
    }
};
