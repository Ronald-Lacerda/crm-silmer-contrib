<script setup>
import { nextTick, ref } from 'vue';
import { INBOX_BUCKETS } from '../../lib/inbox-turn.js';

/**
 * RFC 052 (INBOX-VEZ-02): whose turn it is, one tab per conversation.
 * Selection stays neutral (RFC 022); the count names the tab.
 */
const props = defineProps({
  /** The selected tab (`respond`, `awaiting`, `silent` or `lost`). */
  bucket: { type: String, required: true },
  /**
   * One snapshot of the four tab totals; a tab without a finite total hides
   * the number rather than showing a stale one.
   *
   * @type {import('vue').PropType<Record<string, number>>}
   */
  counts: { type: Object, default: () => ({}) },
});
/**
 * `select(value, focusList)`: a click, Enter or Space asks the parent to take
 * the focus to the list's summary (`focusList` omitted); the arrows keep it on
 * the tabs (`focusList` false).
 */
const emit = defineEmits(['select']);

/** @type {import('vue').Ref<HTMLButtonElement[]>} */
const bucketTabs = ref([]);

/** @param {string} value */
function bucketCount(value) {
  const count = props.counts[value];
  return Number.isFinite(count) ? count : null;
}
/**
 * "Responder, 12 conversas": the count belongs to the tab's name. Without a
 * total the name says so, and never collides with the reply field, whose
 * label is also "Responder".
 *
 * @param {(typeof INBOX_BUCKETS)[number]} item
 */
function bucketAccessibleName(item) {
  const count = bucketCount(item.value);
  if (count === null) return `${item.name}, total indisponível`;
  return `${item.name}, ${count} ${count === 1 ? 'conversa' : 'conversas'}`;
}

/** @param {string} value */
function select(value) {
  emit('select', value);
}

/** design.md §8 Tabs: arrows between tabs, Home/End, roving tabindex. @param {KeyboardEvent} event @param {number} index */
async function bucketKeydown(event, index) {
  const last = INBOX_BUCKETS.length - 1;
  /** @type {Record<string, number>} */
  const moves = {
    ArrowLeft: index === 0 ? last : index - 1,
    ArrowRight: index === last ? 0 : index + 1,
    Home: 0,
    End: last,
  };
  const target = moves[event.key];
  if (target === undefined) return;
  event.preventDefault();
  emit('select', INBOX_BUCKETS[target].value, false);
  await nextTick();
  bucketTabs.value[target]?.focus();
}
</script>

<template>
  <div class="inbox-tabs" role="tablist" aria-label="Vez de responder">
    <button
      v-for="(item, index) in INBOX_BUCKETS"
      :id="`inbox-tab-${item.value}`"
      :key="item.value"
      :ref="(element) => (bucketTabs[index] = element)"
      type="button"
      role="tab"
      class="inbox-tab"
      aria-controls="inbox-bucket-panel"
      :aria-selected="bucket === item.value ? 'true' : 'false'"
      :aria-label="bucketAccessibleName(item)"
      :tabindex="bucket === item.value ? 0 : -1"
      @click="select(item.value)"
      @keydown="bucketKeydown($event, index)"
    >
      <span class="inbox-tab-label">{{ item.label }}</span>
      <span
        v-if="bucketCount(item.value) !== null"
        class="inbox-tab-count"
        aria-hidden="true"
        :data-tone="
          item.value === 'respond' && bucketCount(item.value) > 0
            ? 'attention'
            : undefined
        "
        >{{ bucketCount(item.value) }}</span
      >
    </button>
  </div>
</template>
