import { randomUUID } from 'node:crypto';
import { encryptJson } from '../../modules/orders/src/adapters/envelope.js';
export const KEY = Buffer.alloc(32, 91);
export const SELLER = { id: 'billing-seller', kind: 'human' };
export const NOW = new Date('2026-11-05T15:00:00.000Z');
const current = NOW;
/** @param {any} pool @param {any} [options] */
export async function seed(pool, options = {}) {
  const id = `billing-order-${randomUUID()}`;
  const store = options.origin === 'loja';
  const contact = store ? null : `contact-${id}`;
  if (contact)
    await pool.query(
      'INSERT INTO crm.contacts(id,created_at,updated_at) VALUES ($1,$2,$2)',
      [contact, current],
    );
  const conversationId = options.conversation ? `conversation-${id}` : null;
  if (conversationId) {
    const identityId = `identity-${id}`;
    const lookupHash = randomUUID().replaceAll('-', '').padEnd(64, '0');
    await pool.query(
      `INSERT INTO crm.contact_identities(id,current_contact_id,provider,provider_account_id,channel,external_identity_lookup_hash,identity_kind,phone_status,identity_envelope,created_at,updated_at)
      VALUES ($1,$2,'meta','billing-local-test','whatsapp',$3,'phone','confirmed',$4::jsonb,$5,$5)`,
      [
        identityId,
        contact,
        lookupHash,
        JSON.stringify(
          encryptJson(
            { externalIdentityId: 'synthetic-contact' },
            JSON.stringify(['crm.contact_identities', 1, lookupHash]),
            KEY,
          ),
        ),
        current,
      ],
    );
    await pool.query(
      `INSERT INTO crm.conversations(id,contact_identity_id,provider,provider_account_id,external_conversation_id,cycle_number,assigned_user_id,opened_at,last_message_at)
      VALUES ($1,$2,'meta','billing-local-test',$1,1,$3,$4,$4)`,
      [conversationId, identityId, options.owner ?? SELLER.id, current],
    );
  }
  const sequence = Number(
    (await pool.query("SELECT nextval('crm.order_number_seq') AS n")).rows[0].n,
  );
  const nsu = options.nsu ?? randomUUID();
  await pool.query(
    `INSERT INTO crm.orders(id,number_sequence,number,conversation_id,contact_id,manual_owner_id,manual_create_key,origin,status,fab_code,ficha_envelope,total_pieces,final_amount_cents,payment_condition,order_date,confirmed_at,confirmed_by,created_by_kind,created_by,created_at,updated_at,paid_on,is_test,store_number,lead_time_business_days,payment_source,payment_confirmed_at,paid_amount_cents,payment_transaction_nsu,payment_invoice_slug)
    VALUES ($1,$2,$3,$21,$4,$5,$6,$7,$8,'01',$9::jsonb,2,$10,'pix','2026-11-05',$11,$12,'user',$12,$11,$11,$13::date,false,$14,$15,$16,$17,$18,$19,$20)`,
    [
      id,
      sequence,
      `${String(sequence).padStart(2, '0')}-CRM`,
      contact,
      store || conversationId ? null : (options.owner ?? SELLER.id),
      store || conversationId ? null : randomUUID(),
      store ? 'loja' : 'atendimento',
      options.status ?? 'confirmado',
      JSON.stringify(
        encryptJson(
          {
            summary: { cliente: 'Cliente sintético' },
            items: [],
            artwork: {},
            serviceData: {},
          },
          `order-ficha:${id}`,
          KEY,
        ),
      ),
      options.amount ?? 10000,
      current,
      SELLER.id,
      store ? '2026-11-05' : (options.paidOn ?? null),
      store ? 'LJ-A1B2C3D4' : null,
      store ? 10 : null,
      store ? 'infinitepay' : null,
      store ? current : null,
      store ? (options.amount ?? 10000) : null,
      store ? nsu : null,
      store ? 'synthetic-invoice' : null,
      conversationId,
    ],
  );
  return id;
}
