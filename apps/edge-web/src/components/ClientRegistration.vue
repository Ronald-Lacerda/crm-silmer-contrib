<script setup>
/**
 * "Cadastro" of the selected client (CP-25..28, ADR 047). Reads and edits the
 * optional registration inline, in the same pattern as "Editar nome": the
 * draft and the version opened for editing survive live refreshes, a
 * conflict keeps what was typed, and focus returns to the button that opened
 * the form. Values never leave this component except in the two requests.
 */
import {
  computed,
  nextTick,
  onBeforeUnmount,
  reactive,
  ref,
  useId,
  watch,
} from 'vue';
import { commandKey, request } from '../lib/api-client.js';
import {
  BRAZILIAN_STATE_NAMES,
  BRAZILIAN_STATES,
  PERSON_TYPE_LABELS,
  REGISTRATION_ERROR_FIELDS,
  REGISTRATION_FIELDS,
  formatDocument,
  formatPostalCode,
  isRegistrationComplete,
  missingRegistrationFields,
  normalizeContactRegistration,
  normalizeEmail,
  normalizePhone,
  postalCodeDigits,
} from '../lib/contact-registration.js';
import { formatPhoneNumber } from '../lib/format.js';

const props = defineProps({
  contact: { type: Object, required: true },
});
const emit = defineEmits(['saved', 'loaded']);

/** Form order; also the order of the error summary. */
const FIELD_ORDER = [...REGISTRATION_FIELDS, 'phone', 'email'];
const ADDRESS_FIELDS = /** @type {const} */ ([
  'street',
  'district',
  'city',
  'state',
]);

const uid = useId();
/** @param {string} field */
const fieldId = (field) => `${uid}-${field}`;

const editing = ref(false);
const saving = ref(false);
const conflict = ref(false);
/** '' before the reload, 'differs' or 'unavailable' after it. */
const conflictState = ref('');
const generalError = ref('');
const formNotice = ref('');
/** @type {import('vue').Ref<Record<string, string>>} */
const errors = ref({});
const cepStatus = ref('');
/**
 * What the form was opened from: the version every save starts at and the
 * phone/e-mail it compares against. A successful `/details` moves it forward
 * so a retry never repeats that step.
 *
 * @type {import('vue').Ref<null|{contactId: string, version: number, phone: string|null, phoneSource: string|null, email: string|null, registration: Record<string, string|null>}>}
 */
const base = ref(null);
const draft = reactive({
  personType: '',
  document: '',
  legalName: '',
  instagram: '',
  stateRegistration: '',
  stateRegistrationExempt: false,
  postalCode: '',
  city: '',
  state: '',
  street: '',
  district: '',
  number: '',
  complement: '',
  phone: '',
  email: '',
});

const trigger = ref(null);
const summary = ref(null);
const conflictAlert = ref(null);
const generalAlert = ref(null);
const notice = ref(null);

const PARTIAL_SAVE =
  'Celular e e-mail salvos; o restante do cadastro não foi salvo.';

/** @type {{fingerprint: string, key: string}} */
let detailsAttempt = { fingerprint: '', key: '' };
/** @type {{fingerprint: string, key: string}} */
let registrationAttempt = { fingerprint: '', key: '' };
/** @type {AbortController|undefined} */
let cepController;
let cepSequence = 0;
let lastCepLookup = '';
/** @type {Record<string, string>} */
let cepFilled = {};

const registration = computed(() => props.contact.registration ?? null);
const complete = computed(() =>
  props.contact.registrationStatus
    ? props.contact.registrationStatus === 'complete'
    : isRegistrationComplete(registration.value, props.contact),
);
const missing = computed(() =>
  missingRegistrationFields(registration.value, props.contact),
);
const hasRegistration = computed(() =>
  Boolean(
    registration.value &&
    REGISTRATION_FIELDS.some((field) => registration.value?.[field]),
  ),
);
const facts = computed(() => {
  const data = registration.value;
  if (!data) return [];
  const company = data.personType === 'company';
  /** @type {{label: string, lines: string[]}[]} */
  const rows = [];
  /** @param {string} label @param {...(string|null|undefined|false)} lines */
  const add = (label, ...lines) => {
    const present = /** @type {string[]} */ (lines.filter(Boolean));
    if (present.length) rows.push({ label, lines: present });
  };
  add(
    'Tipo de pessoa',
    PERSON_TYPE_LABELS[
      /** @type {keyof typeof PERSON_TYPE_LABELS} */ (data.personType)
    ],
  );
  add(
    company ? 'CNPJ' : data.personType ? 'CPF' : 'CPF ou CNPJ',
    data.document && formatDocument(data.personType, data.document),
  );
  add(company ? 'Razão social' : 'Nome completo', data.legalName);
  add('Instagram', data.instagram && `@${data.instagram}`);
  add(
    'Inscrição estadual',
    data.stateRegistration === 'ISENTO' ? 'Isento' : data.stateRegistration,
  );
  const streetLine = [data.street, data.number].filter(Boolean).join(', ');
  const placeLine = [
    data.district,
    [data.city, data.state].filter(Boolean).join('/'),
  ]
    .filter(Boolean)
    .join(' · ');
  add(
    'Endereço',
    [streetLine, data.complement].filter(Boolean).join(' — '),
    placeLine,
    data.postalCode && `CEP ${formatPostalCode(data.postalCode)}`,
  );
  return rows;
});

const company = computed(() => draft.personType === 'company');
const contactName = computed(() => text(props.contact.displayName).trim());
const documentLabel = computed(() =>
  draft.personType === 'company'
    ? 'CNPJ'
    : draft.personType === 'individual'
      ? 'CPF'
      : 'CPF ou CNPJ',
);
const phoneLocked = computed(() =>
  Boolean(
    base.value?.phone &&
    ['manual', 'whatsapp'].includes(String(base.value.phoneSource)),
  ),
);
const summaryItems = computed(() =>
  FIELD_ORDER.filter((field) => errors.value[field]).map((field) => ({
    field,
    text: `${fieldLabel(field)}: ${errorText(field)}`,
  })),
);

/** @param {string} field */
function fieldLabel(field) {
  switch (field) {
    case 'personType':
      return 'Tipo de pessoa';
    case 'document':
      return documentLabel.value;
    case 'legalName':
      return company.value ? 'Razão social' : 'Nome completo';
    case 'instagram':
      return '@ do Instagram';
    case 'stateRegistration':
      return 'Inscrição estadual';
    case 'postalCode':
      return 'CEP';
    case 'city':
      return 'Cidade';
    case 'state':
      return 'UF';
    case 'street':
      return 'Endereço';
    case 'district':
      return 'Bairro';
    case 'number':
      return 'Número';
    case 'complement':
      return 'Complemento';
    case 'phone':
      return 'Celular';
    default:
      return 'E-mail';
  }
}

/** @param {string} field */
function errorText(field) {
  const code = errors.value[field];
  if (!code) return '';
  switch (field) {
    case 'personType':
      return 'Escolha pessoa física ou jurídica para informar o documento.';
    case 'document':
      return company.value
        ? 'CNPJ inválido. Confira os 14 caracteres.'
        : 'CPF inválido. Confira os 11 números.';
    case 'legalName':
      return 'Use de 2 a 150 caracteres.';
    case 'instagram':
      return 'Use até 30 letras, números, ponto ou sublinhado.';
    case 'stateRegistration':
      return 'Use de 2 a 18 letras ou números, ou marque Isento.';
    case 'postalCode':
      return 'Informe os 8 números do CEP.';
    case 'city':
    case 'district':
    case 'complement':
      return 'Use até 80 caracteres.';
    case 'street':
      return 'Use até 150 caracteres.';
    case 'state':
      return 'Escolha uma das 27 UFs.';
    case 'number':
      return 'Use até 10 caracteres, ou S/N.';
    case 'phone':
      if (code === 'CONTACT_PHONE_MATCH')
        return 'Este celular já está no cadastro de outro cliente.';
      if (code === 'EMAIL_NEEDS_PHONE')
        return 'Informe o celular para salvar o e-mail.';
      return 'Informe um celular brasileiro válido com DDD.';
    default:
      return 'Informe um e-mail válido, como nome@exemplo.com.';
  }
}

/** @param {string} field @param {string} [hint] */
function fieldAttrs(field, hint) {
  const describedBy = [
    hint ? fieldId(`${field}-hint`) : '',
    errors.value[field] ? fieldId(`${field}-error`) : '',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    id: fieldId(field),
    'aria-describedby': describedBy || undefined,
    'aria-invalid': errors.value[field] ? 'true' : undefined,
  };
}

/** @param {unknown} value */
function text(value) {
  return typeof value === 'string' ? value : '';
}

async function open() {
  const contact = props.contact;
  const data = contact.registration ?? {};
  const exempt = data.stateRegistration === 'ISENTO';
  draft.personType = text(data.personType);
  draft.document = data.document
    ? formatDocument(data.personType, data.document)
    : '';
  // CP-26: never pre-filled, so opening and saving changes nothing.
  draft.legalName = text(data.legalName);
  draft.instagram = data.instagram ? `@${data.instagram}` : '';
  draft.stateRegistrationExempt = exempt;
  draft.stateRegistration = exempt ? '' : text(data.stateRegistration);
  draft.postalCode = data.postalCode ? formatPostalCode(data.postalCode) : '';
  draft.city = text(data.city);
  draft.state = text(data.state);
  draft.street = text(data.street);
  draft.district = text(data.district);
  draft.number = text(data.number);
  draft.complement = text(data.complement);
  draft.phone = '';
  draft.email = text(contact.email);
  base.value = {
    contactId: String(contact.id),
    version: Number(contact.version),
    phone: contact.phone ? String(contact.phone) : null,
    phoneSource: contact.phoneSource ? String(contact.phoneSource) : null,
    email: contact.email ? String(contact.email) : null,
    registration: Object.fromEntries(
      REGISTRATION_FIELDS.map((field) => [field, data[field] ?? null]),
    ),
  };
  detailsAttempt = { fingerprint: '', key: '' };
  registrationAttempt = { fingerprint: '', key: '' };
  lastCepLookup = postalCodeDigits(data.postalCode);
  cepFilled = {};
  cepStatus.value = '';
  errors.value = {};
  generalError.value = '';
  formNotice.value = '';
  conflict.value = false;
  conflictState.value = '';
  editing.value = true;
  await nextTick();
  const radios = /** @type {NodeListOf<HTMLInputElement>} */ (
    globalThis.document.querySelectorAll(`[name="${fieldId('personType')}"]`)
  );
  ([...radios].find((radio) => radio.checked) ?? radios[0])?.focus();
}

async function close() {
  cepController?.abort();
  cepSequence += 1;
  editing.value = false;
  base.value = null;
  cepStatus.value = '';
  await nextTick();
  /** @type {HTMLElement|null} */ (trigger.value)?.focus();
}

/**
 * Esc cancels, except inside a select, whose own popup uses it.
 *
 * @param {KeyboardEvent} event
 */
function onEscape(event) {
  const target = /** @type {HTMLElement|null} */ (event.target);
  if (event.defaultPrevented || event.isComposing) return;
  if (target?.tagName === 'SELECT') return;
  event.preventDefault();
  void cancel();
}

async function useContactName() {
  draft.legalName = contactName.value;
  await focusField('legalName');
}

async function cancel() {
  if (saving.value) return;
  const hadConflict = conflict.value;
  await close();
  if (hadConflict) await fetchCurrent();
}

/** @returns {Promise<Record<string, any>|null>} */
async function fetchCurrent() {
  try {
    const response = await request(
      `/api/v1/contacts/${encodeURIComponent(String(props.contact.id))}`,
    );
    emit('loaded', response.data);
    return response.data ?? null;
  } catch {
    return null;
  }
}

/** @param {unknown} value */
function nullable(value) {
  return value ? String(value) : null;
}

/**
 * CP-27: a 409 only blocks when the registration itself moved. When another
 * part of the contact changed (name, phone, e-mail) the draft is still based
 * on what is saved, so the form moves to the new version and stays editable.
 */
async function refreshConflict() {
  const data = await fetchCurrent();
  const current = base.value;
  if (!current) return;
  if (!data?.contact) {
    conflictState.value = 'unavailable';
    return;
  }
  const server = data.contact;
  const serverData = server.registration ?? {};
  const serverRegistration = Object.fromEntries(
    REGISTRATION_FIELDS.map((field) => [field, serverData[field] ?? null]),
  );
  const serverDetails = {
    email: nullable(server.email),
    phone: nullable(server.phone),
    phoneSource: nullable(server.phoneSource),
  };
  const detailsSame =
    serverDetails.email === current.email &&
    serverDetails.phone === current.phone &&
    serverDetails.phoneSource === current.phoneSource;
  const typedEmail = normalizeEmail(draft.email);
  const detailsTouched =
    (typedEmail === undefined ? draft.email : (typedEmail ?? null)) !==
      current.email ||
    (!phoneLocked.value && draft.phone.trim() !== '');
  if (
    sameRegistration(serverRegistration, current.registration) &&
    (detailsSame || !detailsTouched)
  ) {
    if (!detailsSame) {
      draft.email = serverDetails.email ?? '';
      draft.phone = '';
    }
    base.value = {
      ...current,
      ...serverDetails,
      version: Number(server.version),
    };
    detailsAttempt = { fingerprint: '', key: '' };
    registrationAttempt = { fingerprint: '', key: '' };
    conflict.value = false;
    conflictState.value = '';
    formNotice.value =
      'Só outra parte do cliente mudou, como nome, celular ou e-mail. O cadastro continua como você abriu e seu rascunho foi mantido. Confira e salve de novo.';
    await nextTick();
    /** @type {HTMLElement|null} */ (notice.value)?.focus();
    return;
  }
  conflictState.value = 'differs';
  await nextTick();
  /** @type {HTMLElement|null} */ (conflictAlert.value)?.focus();
}

async function discardDraft() {
  conflict.value = false;
  await nextTick();
  await open();
  formNotice.value =
    'Seu rascunho foi descartado e o cadastro atual foi carregado.';
}

/** @param {string} field */
async function focusField(field) {
  await nextTick();
  const target =
    field === 'personType'
      ? globalThis.document.querySelector(`[name="${fieldId(field)}"]`)
      : globalThis.document.getElementById(fieldId(field));
  /** @type {HTMLElement|null} */ (target)?.focus();
}

/** @param {Record<string, string>} found */
async function showFieldErrors(found) {
  errors.value = found;
  await nextTick();
  /** @type {HTMLElement|null} */ (summary.value)?.focus();
}

/** @param {string} message */
async function showGeneralError(message) {
  generalError.value = message;
  await nextTick();
  /** @type {HTMLElement|null} */ (generalAlert.value)?.focus();
}

/**
 * The same attempt keeps its Idempotency-Key, so a retry after a lost answer
 * is a replay; anything typed since then is a new command with a new key.
 *
 * @param {{fingerprint: string, key: string}} attempt @param {unknown} body
 */
function keyFor(attempt, body) {
  const fingerprint = JSON.stringify(body);
  if (attempt.fingerprint !== fingerprint || !attempt.key) {
    attempt.fingerprint = fingerprint;
    attempt.key = commandKey();
  }
  return attempt.key;
}

/** @param {Record<string, unknown>} left @param {Record<string, unknown>} right */
function sameRegistration(left, right) {
  return REGISTRATION_FIELDS.every(
    (field) => (left[field] ?? null) === (right[field] ?? null),
  );
}

async function save() {
  const current = base.value;
  if (!current || saving.value || conflict.value) return;
  generalError.value = '';
  formNotice.value = '';
  const result = normalizeContactRegistration({
    personType: draft.personType || null,
    document: draft.document,
    legalName: draft.legalName,
    instagram: draft.instagram,
    stateRegistration: draft.stateRegistrationExempt
      ? 'ISENTO'
      : draft.stateRegistration,
    postalCode: draft.postalCode,
    city: draft.city,
    state: draft.state,
    street: draft.street,
    district: draft.district,
    number: draft.number,
    complement: draft.complement,
  });
  /** @type {Record<string, string>} */
  const found = result.ok ? {} : { ...result.errors };
  let phone = phoneLocked.value ? current.phone : null;
  if (!phoneLocked.value && draft.phone.trim()) {
    phone = normalizePhone(draft.phone.trim());
    if (!phone) found.phone = 'INVALID_PHONE';
  }
  const email = normalizeEmail(draft.email);
  if (email === undefined) found.email = 'INVALID_EMAIL';
  else if (email && !phone && !found.phone) found.phone = 'EMAIL_NEEDS_PHONE';
  if (!result.ok || Object.keys(found).length) {
    await showFieldErrors(found);
    return;
  }
  errors.value = {};
  const detailsChanged =
    Boolean(phone) &&
    (!phoneLocked.value || (email ?? null) !== (current.email ?? null));
  const registrationChanged = !sameRegistration(
    result.value,
    current.registration,
  );
  if (!detailsChanged && !registrationChanged) {
    await close();
    return;
  }

  saving.value = true;
  const contactId = encodeURIComponent(current.contactId);
  /** @type {Record<string, unknown>} */
  const patch = { id: current.contactId };
  let detailsSaved = false;
  try {
    if (detailsChanged) {
      const body = { email, expectedVersion: current.version, phone };
      const response = await request(`/api/v1/contacts/${contactId}/details`, {
        body,
        idempotencyKey: keyFor(detailsAttempt, body),
        method: 'POST',
      });
      const saved = response.data?.contact ?? {};
      current.version = Number(saved.version);
      current.phone = phone;
      current.phoneSource = 'manual';
      current.email = email ?? null;
      detailsAttempt = { fingerprint: '', key: '' };
      detailsSaved = true;
      Object.assign(patch, {
        email: current.email,
        phone,
        phoneSource: 'manual',
        version: current.version,
      });
    }
    if (registrationChanged) {
      const body = {
        expectedVersion: current.version,
        registration: result.value,
      };
      const response = await request(
        `/api/v1/contacts/${contactId}/registration`,
        {
          body,
          idempotencyKey: keyFor(registrationAttempt, body),
          method: 'PUT',
        },
      );
      const saved = response.data?.contact ?? {};
      current.version = Number(saved.version);
      current.registration = { ...result.value };
      registrationAttempt = { fingerprint: '', key: '' };
      Object.assign(patch, {
        registration: saved.registration ?? result.value,
        registrationStatus: saved.registrationStatus,
        version: current.version,
      });
    }
    emit('saved', patch);
    await close();
  } catch (cause) {
    // CP-25: phone and e-mail already saved reach the ficha even when the
    // registration did not.
    if (detailsSaved) emit('saved', { ...patch }, true);
    await handleSaveError(cause, detailsSaved);
  } finally {
    saving.value = false;
  }
}

/** @param {any} cause @param {boolean} [partial] */
async function handleSaveError(cause, partial = false) {
  const prefix = partial ? `${PARTIAL_SAVE} ` : '';
  // Shown beside a field error or the conflict, which take the focus.
  generalError.value = partial ? `${PARTIAL_SAVE} Tente de novo.` : '';
  const status = Number(cause?.status);
  const code = String(cause?.code ?? '');
  // A definitive answer ends the attempt; the next save is a new command.
  if ([400, 403, 404, 409].includes(status)) {
    detailsAttempt = { fingerprint: '', key: '' };
    registrationAttempt = { fingerprint: '', key: '' };
  }
  if (status === 409 && code === 'CONTACT_PHONE_MATCH') {
    await showFieldErrors({ phone: code });
    return;
  }
  if (status === 409) {
    conflict.value = true;
    conflictState.value = '';
    await nextTick();
    /** @type {HTMLElement|null} */ (conflictAlert.value)?.focus();
    return;
  }
  if (status === 400) {
    const reported = String(cause?.problem?.field ?? '');
    const field = FIELD_ORDER.includes(reported)
      ? reported
      : REGISTRATION_ERROR_FIELDS[code];
    if (field) {
      await showFieldErrors({ [field]: code || 'INVALID' });
      return;
    }
    await showGeneralError(
      `${prefix}O cadastro não foi aceito. Confira os dados e tente de novo.`,
    );
    return;
  }
  if (status === 403) {
    await showGeneralError(
      `${prefix}Sem permissão para editar o cadastro deste cliente.`,
    );
    return;
  }
  if (status === 404) {
    await showGeneralError(
      `${prefix}Cliente não encontrado. Ele pode ter sido unido a outro cadastro; recarregue a página.`,
    );
    return;
  }
  await showGeneralError(
    partial
      ? `${PARTIAL_SAVE} Tente de novo.`
      : 'Não foi possível salvar agora. O que você digitou foi mantido; tente de novo.',
  );
}

/** @param {Record<string, any>} data */
function applyAddress(data) {
  let filled = false;
  for (const field of ADDRESS_FIELDS) {
    let incoming = typeof data?.[field] === 'string' ? data[field].trim() : '';
    if (field === 'state') {
      incoming = incoming.toUpperCase();
      if (!BRAZILIAN_STATES.includes(incoming)) incoming = '';
    }
    const value = draft[field];
    const previous = cepFilled[field];
    const ours =
      value.trim() === '' || (previous !== undefined && value === previous);
    if (!ours) continue;
    if (incoming) {
      draft[field] = incoming;
      cepFilled[field] = incoming;
      filled = true;
    } else if (previous !== undefined) {
      draft[field] = '';
      delete cepFilled[field];
    }
  }
  return filled;
}

/** @param {string} digits */
async function lookupPostalCode(digits) {
  cepController?.abort();
  const controller = new AbortController();
  cepController = controller;
  const sequence = ++cepSequence;
  lastCepLookup = digits;
  cepStatus.value = 'Buscando endereço…';
  try {
    // A POST keeps the CEP out of URLs and access logs (CSRF as usual).
    const response = await request('/api/v1/postal-codes/lookup', {
      body: { postalCode: digits },
      method: 'POST',
      signal: controller.signal,
    });
    if (sequence !== cepSequence || !editing.value) return;
    const filled = applyAddress(response.data ?? {});
    cepStatus.value = filled
      ? 'Endereço preenchido pelo CEP. Confira.'
      : 'CEP encontrado. O endereço que você digitou foi mantido.';
    // Focus stays where the person is: only the live region announces it.
  } catch (cause) {
    if (
      sequence !== cepSequence ||
      /** @type {any} */ (cause)?.name === 'AbortError'
    )
      return;
    const status = Number(/** @type {any} */ (cause)?.status);
    if (status === 404) {
      cepStatus.value = 'CEP não encontrado. Preencha o endereço.';
    } else if (status === 400) {
      cepStatus.value = 'CEP inválido. Confira os 8 números.';
    } else {
      // Unavailable or rate limited: editing the CEP again may retry it.
      lastCepLookup = '';
      cepStatus.value = 'Consulta de CEP indisponível. Preencha o endereço.';
    }
  }
}

watch(
  () => draft.postalCode,
  (value, previous) => {
    if (!editing.value) return;
    const digits = postalCodeDigits(value);
    if (digits === postalCodeDigits(previous)) return;
    if (digits.length !== 8) {
      cepController?.abort();
      cepSequence += 1;
      cepStatus.value = '';
      return;
    }
    if (digits !== lastCepLookup) void lookupPostalCode(digits);
  },
);

watch(
  () => draft.stateRegistrationExempt,
  (exempt) => {
    if (exempt && errors.value.stateRegistration) {
      const rest = { ...errors.value };
      delete rest.stateRegistration;
      errors.value = rest;
    }
  },
);

onBeforeUnmount(() => {
  cepController?.abort();
});
</script>

<template>
  <section class="client-registration" :aria-labelledby="fieldId('heading')">
    <div class="panel-head subsection-heading registration-head">
      <h3 :id="fieldId('heading')">Cadastro</h3>
      <span class="badge" :data-tone="complete ? 'success' : undefined">
        {{ complete ? 'Cadastro completo' : 'Cadastro incompleto' }}
      </span>
    </div>

    <template v-if="!editing">
      <p v-if="!hasRegistration" class="registration-note">
        Nenhum dado de cadastro informado. O cadastro é opcional e não impede
        conversas nem pedidos.
      </p>
      <p v-else-if="!complete && missing.length" class="registration-note">
        Falta: {{ missing.join(', ') }}.
      </p>
      <dl v-if="facts.length" class="client-facts registration-facts">
        <div v-for="fact in facts" :key="fact.label">
          <dt>{{ fact.label }}</dt>
          <dd>
            <span v-for="line in fact.lines" :key="line" class="fact-line">{{
              line
            }}</span>
          </dd>
        </div>
      </dl>
      <button ref="trigger" type="button" @click="open">
        {{ hasRegistration ? 'Editar cadastro' : 'Completar cadastro' }}
      </button>
    </template>

    <form
      v-else
      class="registration-form"
      novalidate
      :aria-labelledby="fieldId('heading')"
      @submit.prevent="save"
      @keydown.esc="onEscape"
    >
      <div
        v-if="summaryItems.length"
        ref="summary"
        class="registration-summary"
        tabindex="-1"
        role="group"
        :aria-labelledby="fieldId('summary-title')"
      >
        <h4 :id="fieldId('summary-title')">
          {{
            summaryItems.length === 1
              ? 'Revise 1 campo antes de salvar'
              : `Revise ${summaryItems.length} campos antes de salvar`
          }}
        </h4>
        <ul>
          <li v-for="item in summaryItems" :key="item.field">
            <a
              :href="`#${fieldId(item.field)}`"
              @click.prevent="focusField(item.field)"
              >{{ item.text }}</a
            >
          </li>
        </ul>
      </div>

      <div
        v-if="conflict"
        ref="conflictAlert"
        class="audit-note"
        role="alert"
        tabindex="-1"
      >
        <p>
          O cadastro deste cliente mudou enquanto você editava. O que você
          digitou foi mantido, mas não foi salvo.
        </p>
        <template v-if="conflictState === 'differs'">
          <p>
            O cadastro salvo agora é diferente do que você abriu. Descarte seu
            rascunho para carregar o cadastro atual, ou cancele.
          </p>
          <button type="button" @click="discardDraft">
            Descartar rascunho e carregar o atual
          </button>
        </template>
        <template v-else>
          <p v-if="conflictState === 'unavailable'">
            Não foi possível consultar o cliente agora. Tente de novo ou
            cancele.
          </p>
          <p v-else>Recarregue o cliente para conferir o que mudou.</p>
          <button type="button" @click="refreshConflict">
            Recarregar cliente
          </button>
        </template>
      </div>

      <p
        v-if="formNotice"
        ref="notice"
        class="registration-notice"
        role="status"
        tabindex="-1"
      >
        {{ formNotice }}
      </p>

      <p
        v-if="generalError"
        ref="generalAlert"
        class="registration-alert"
        role="alert"
        tabindex="-1"
      >
        {{ generalError }}
      </p>

      <fieldset
        class="registration-choice"
        :aria-describedby="
          errors.personType ? fieldId('personType-error') : undefined
        "
      >
        <legend>Tipo de pessoa</legend>
        <div class="choice-row">
          <label>
            <input
              v-model="draft.personType"
              type="radio"
              value="individual"
              :name="fieldId('personType')"
              :aria-invalid="errors.personType ? 'true' : undefined"
            />
            Física
          </label>
          <label>
            <input
              v-model="draft.personType"
              type="radio"
              value="company"
              :name="fieldId('personType')"
              :aria-invalid="errors.personType ? 'true' : undefined"
            />
            Jurídica
          </label>
        </div>
        <p
          v-if="errors.personType"
          :id="fieldId('personType-error')"
          class="field-error"
        >
          {{ errorText('personType') }}
        </p>
      </fieldset>

      <div class="registration-field">
        <label :for="fieldId('document')">{{ documentLabel }}</label>
        <input
          v-bind="fieldAttrs('document', company ? 'hint' : undefined)"
          v-model="draft.document"
          type="text"
          :inputmode="company ? 'text' : 'numeric'"
          autocapitalize="characters"
          autocomplete="off"
          spellcheck="false"
          maxlength="18"
          @blur="
            draft.document = formatDocument(draft.personType, draft.document)
          "
        />
        <p v-if="company" :id="fieldId('document-hint')" class="field-hint">
          Aceita o CNPJ com letras.
        </p>
        <p
          v-if="errors.document"
          :id="fieldId('document-error')"
          class="field-error"
        >
          {{ errorText('document') }}
        </p>
      </div>

      <div class="registration-field">
        <label :for="fieldId('legalName')">{{
          company ? 'Razão social' : 'Nome completo'
        }}</label>
        <input
          v-bind="fieldAttrs('legalName')"
          v-model="draft.legalName"
          type="text"
          :autocomplete="company ? 'organization' : 'name'"
          maxlength="150"
        />
        <button
          v-if="contactName && !draft.legalName.trim()"
          type="button"
          class="link-button registration-use-name"
          @click="useContactName"
        >
          Usar nome do contato: {{ contactName }}
        </button>
        <p
          v-if="errors.legalName"
          :id="fieldId('legalName-error')"
          class="field-error"
        >
          {{ errorText('legalName') }}
        </p>
      </div>

      <div class="registration-field">
        <label :for="fieldId('instagram')">@ do Instagram</label>
        <input
          v-bind="fieldAttrs('instagram')"
          v-model="draft.instagram"
          type="text"
          autocapitalize="none"
          autocomplete="off"
          spellcheck="false"
          maxlength="100"
        />
        <p
          v-if="errors.instagram"
          :id="fieldId('instagram-error')"
          class="field-error"
        >
          {{ errorText('instagram') }}
        </p>
      </div>

      <div class="registration-field">
        <label :for="fieldId('stateRegistration')">Inscrição estadual</label>
        <input
          v-bind="fieldAttrs('stateRegistration', 'hint')"
          v-model="draft.stateRegistration"
          type="text"
          autocapitalize="characters"
          autocomplete="off"
          spellcheck="false"
          maxlength="25"
          :disabled="draft.stateRegistrationExempt"
        />
        <label class="choice-inline">
          <input v-model="draft.stateRegistrationExempt" type="checkbox" />
          Isento
        </label>
        <p :id="fieldId('stateRegistration-hint')" class="field-hint">
          {{
            company
              ? 'Necessária para o cadastro completo. Marque Isento se não houver.'
              : 'Opcional para pessoa física.'
          }}
        </p>
        <p
          v-if="errors.stateRegistration"
          :id="fieldId('stateRegistration-error')"
          class="field-error"
        >
          {{ errorText('stateRegistration') }}
        </p>
      </div>

      <div class="registration-field">
        <label :for="fieldId('postalCode')">CEP</label>
        <input
          v-bind="fieldAttrs('postalCode', 'hint')"
          v-model="draft.postalCode"
          type="text"
          inputmode="numeric"
          autocomplete="postal-code"
          maxlength="9"
          @blur="draft.postalCode = formatPostalCode(draft.postalCode)"
        />
        <p
          :id="fieldId('postalCode-hint')"
          class="field-hint"
          aria-live="polite"
        >
          {{ cepStatus }}
        </p>
        <p
          v-if="errors.postalCode"
          :id="fieldId('postalCode-error')"
          class="field-error"
        >
          {{ errorText('postalCode') }}
        </p>
      </div>

      <div class="registration-pair">
        <div class="registration-field">
          <label :for="fieldId('city')">Cidade</label>
          <input
            v-bind="fieldAttrs('city')"
            v-model="draft.city"
            type="text"
            autocomplete="address-level2"
            maxlength="80"
          />
          <p v-if="errors.city" :id="fieldId('city-error')" class="field-error">
            {{ errorText('city') }}
          </p>
        </div>
        <div class="registration-field registration-field--narrow">
          <label :for="fieldId('state')">UF</label>
          <select
            v-bind="fieldAttrs('state')"
            v-model="draft.state"
            autocomplete="address-level1"
          >
            <option value="">Selecione</option>
            <option
              v-for="state in BRAZILIAN_STATES"
              :key="state"
              :value="state"
            >
              {{ state }} — {{ BRAZILIAN_STATE_NAMES[state] }}
            </option>
          </select>
          <p
            v-if="errors.state"
            :id="fieldId('state-error')"
            class="field-error"
          >
            {{ errorText('state') }}
          </p>
        </div>
      </div>

      <div class="registration-field">
        <label :for="fieldId('street')">Endereço</label>
        <input
          v-bind="fieldAttrs('street')"
          v-model="draft.street"
          type="text"
          autocomplete="address-line1"
          maxlength="150"
        />
        <p
          v-if="errors.street"
          :id="fieldId('street-error')"
          class="field-error"
        >
          {{ errorText('street') }}
        </p>
      </div>

      <div class="registration-field">
        <label :for="fieldId('district')">Bairro</label>
        <input
          v-bind="fieldAttrs('district')"
          v-model="draft.district"
          type="text"
          autocomplete="off"
          maxlength="80"
        />
        <p
          v-if="errors.district"
          :id="fieldId('district-error')"
          class="field-error"
        >
          {{ errorText('district') }}
        </p>
      </div>

      <div class="registration-pair">
        <div class="registration-field registration-field--narrow">
          <label :for="fieldId('number')">Número</label>
          <input
            v-bind="fieldAttrs('number', 'hint')"
            v-model="draft.number"
            type="text"
            autocomplete="off"
            maxlength="10"
          />
          <p :id="fieldId('number-hint')" class="field-hint">
            S/N se não houver.
          </p>
          <p
            v-if="errors.number"
            :id="fieldId('number-error')"
            class="field-error"
          >
            {{ errorText('number') }}
          </p>
        </div>
        <div class="registration-field">
          <label :for="fieldId('complement')">Complemento</label>
          <input
            v-bind="fieldAttrs('complement')"
            v-model="draft.complement"
            type="text"
            autocomplete="address-line2"
            maxlength="80"
          />
          <p
            v-if="errors.complement"
            :id="fieldId('complement-error')"
            class="field-error"
          >
            {{ errorText('complement') }}
          </p>
        </div>
      </div>

      <div class="registration-field">
        <label :for="fieldId('phone')">Celular</label>
        <input
          v-if="phoneLocked"
          v-bind="fieldAttrs('phone', 'hint')"
          :value="formatPhoneNumber(base?.phone)"
          type="tel"
          readonly
        />
        <input
          v-else
          v-bind="fieldAttrs('phone', 'hint')"
          v-model="draft.phone"
          type="tel"
          inputmode="tel"
          autocomplete="tel"
          maxlength="20"
        />
        <p :id="fieldId('phone-hint')" class="field-hint">
          {{
            phoneLocked
              ? base?.phoneSource === 'whatsapp'
                ? 'Número confirmado pelo WhatsApp. Ele não muda por aqui.'
                : 'Celular já cadastrado. Ele não muda por aqui.'
              : base?.phoneSource === 'site_unverified'
                ? 'O site informou um telefone ainda não confirmado. Digite o celular com DDD para confirmar.'
                : 'Com DDD. Necessário para salvar o e-mail.'
          }}
        </p>
        <p v-if="errors.phone" :id="fieldId('phone-error')" class="field-error">
          {{ errorText('phone') }}
        </p>
      </div>

      <div class="registration-field">
        <label :for="fieldId('email')">E-mail</label>
        <input
          v-bind="fieldAttrs('email')"
          v-model="draft.email"
          type="email"
          autocomplete="email"
          autocapitalize="none"
          spellcheck="false"
          maxlength="254"
        />
        <p v-if="errors.email" :id="fieldId('email-error')" class="field-error">
          {{ errorText('email') }}
        </p>
      </div>

      <div class="inline-actions">
        <button
          type="submit"
          class="primary"
          :disabled="saving || conflict"
          :aria-busy="saving ? 'true' : undefined"
        >
          {{ saving ? 'Salvando…' : 'Salvar cadastro' }}
        </button>
        <button type="button" :disabled="saving" @click="cancel">
          Cancelar
        </button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.registration-head {
  align-items: center;
}

.registration-note {
  margin: 0 0 0.75rem;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

.registration-facts {
  grid-template-columns: minmax(0, 1fr);
  margin-block: 0 1rem;
}

.fact-line {
  display: block;
}

.registration-form {
  gap: var(--space-4);
}

.registration-field {
  display: grid;
  align-content: start;
  gap: var(--space-2);
  min-inline-size: 0;
}

.registration-field label {
  margin-block-end: 0;
}

.registration-pair {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 8.5rem), 1fr));
  gap: var(--space-4);
}

.registration-choice {
  display: grid;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  border: 0;
}

.registration-choice legend {
  margin-block-end: var(--space-2);
  padding: 0;
  font-size: var(--text-sm);
  font-weight: 500;
}

.choice-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-5);
}

.choice-row label,
.choice-inline {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-block-size: 2.75rem;
  margin: 0;
  font-weight: 400;
}

.choice-inline {
  justify-self: start;
}

.field-hint {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}

.field-hint:empty {
  display: none;
}

.field-error,
.registration-alert {
  margin: 0;
  color: var(--status-error-text);
  font-size: var(--text-sm);
  font-weight: 500;
}

.registration-use-name {
  justify-self: start;
}

.registration-notice {
  margin: 0;
  padding: 0.7rem 0.9rem;
  color: var(--status-info-text);
  font-size: var(--text-sm);
  background: var(--status-info-surface);
  border-radius: var(--radius-md);
}

.registration-alert {
  padding: 0.7rem 0.9rem;
  background: var(--status-error-surface);
  border-radius: var(--radius-md);
}

.registration-field input[aria-invalid='true'],
.registration-field select[aria-invalid='true'] {
  border-color: var(--status-error-text);
}

.registration-field input[readonly] {
  color: var(--color-text-muted);
  background: var(--color-surface-muted);
}

.registration-summary {
  padding: 0.85rem 1rem;
  background: var(--status-error-surface);
  border: 1px solid var(--status-error-text);
  border-radius: var(--radius-md);
}

.registration-summary h4 {
  margin: 0 0 var(--space-2);
  color: var(--status-error-text);
  font-size: var(--text-sm);
}

.registration-summary ul {
  display: grid;
  gap: var(--space-1);
  margin: 0;
  padding-inline-start: 1.1rem;
}

.registration-summary a {
  color: var(--status-error-text);
  font-size: var(--text-sm);
}
</style>
