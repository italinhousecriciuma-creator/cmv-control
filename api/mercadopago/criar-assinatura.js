// Vercel Function: cria uma assinatura (preapproval) no Mercado Pago SEM plano
// associado, e devolve o link de checkout hospedado (init_point) pro navegador
// redirecionar o usuário. Nenhum dado de cartão passa por aqui — quem cuida
// disso é a própria página do Mercado Pago.
//
// Variável de ambiente necessária (configurar no painel do Vercel):
//   MP_ACCESS_TOKEN  -> Access Token de produção da sua aplicação no Mercado Pago
//
// Referência oficial: POST https://api.mercadopago.com/preapproval
// (assinatura sem plano associado, sem card_token_id/status = gera init_point
// de checkout hospedado)

const MP_API = 'https://api.mercadopago.com/preapproval';
const VALOR_MENSAL = 49.90;

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Método não permitido' });
        return;
    }

    const accessToken = process.env.MP_ACCESS_TOKEN;
    if (!accessToken) {
        console.error('MP_ACCESS_TOKEN não configurado no ambiente');
        res.status(500).json({ error: 'Configuração de pagamento ausente no servidor.' });
        return;
    }

    try {
        const { userId, email } = req.body || {};
        if (!userId || !email) {
            res.status(400).json({ error: 'userId e email são obrigatórios.' });
            return;
        }

        // back_url: pra onde o Mercado Pago manda o usuário de volta após o checkout.
        // Usamos a origem da própria requisição (funciona em preview e produção do Vercel).
        const origin = req.headers.origin || `https://${req.headers.host}`;

        const payload = {
            reason: 'CMV Control - Plano Pro (mensal)',
            external_reference: userId, // é assim que ligamos a assinatura ao usuário no webhook
            payer_email: email,
            back_url: `${origin}/?assinatura=sucesso`,
            auto_recurring: {
                frequency: 1,
                frequency_type: 'months',
                transaction_amount: VALOR_MENSAL,
                currency_id: 'BRL'
            }
        };

        const mpRes = await fetch(MP_API, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`
            },
            body: JSON.stringify(payload)
        });

        const data = await mpRes.json();

        if (!mpRes.ok) {
            console.error('Erro Mercado Pago ao criar assinatura:', data);
            res.status(mpRes.status).json({ error: data?.message || 'Erro ao criar assinatura no Mercado Pago.' });
            return;
        }

        if (!data.init_point) {
            console.error('Mercado Pago não retornou init_point:', data);
            res.status(502).json({ error: 'Mercado Pago não retornou o link de pagamento.' });
            return;
        }

        res.status(200).json({ init_point: data.init_point, preapproval_id: data.id });
    } catch (e) {
        console.error('Erro inesperado em criar-assinatura:', e);
        res.status(500).json({ error: 'Erro inesperado ao criar assinatura.' });
    }
};
