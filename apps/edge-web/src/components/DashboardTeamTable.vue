<script setup>
import { computed, ref, watch } from 'vue';

/**
 * SalesDataTable (design.md §18, ACT-T04): people first, then channel rows
 * ("Loja do site", "Sem atribuição") and the total, which never move when the
 * people are sorted. Real headers with `scope` and `aria-sort`; sortable
 * headers are buttons inside the `th`. Below 600 px the rows become cards
 * (10-dashboard.css), so the explicit roles and `headers` keep the meaning.
 *
 * @typedef {{text: string, note?: string, value?: number|null, tone?: string}} Cell
 * @typedef {{id: string, name: string, note?: string, cells: Record<string, Cell>}} Row
 * @typedef {{key: string, label: string, sortable?: boolean, meter?: boolean}} Column
 */
const props = defineProps({
  idPrefix: { type: String, required: true },
  caption: { type: String, required: true },
  /** @type {import('vue').PropType<Column[]>} */
  columns: { type: Array, required: true },
  /** @type {import('vue').PropType<Row[]>} */
  rows: { type: Array, required: true },
  /** @type {import('vue').PropType<Row[]>} */
  extraRows: { type: Array, default: () => [] },
  /** @type {import('vue').PropType<Row|null>} */
  totalRow: { type: Object, default: null },
  /** The column the API already sorted by (descending). */
  sortedBy: { type: String, default: '' },
  sortable: { type: Boolean, default: false },
  emptyText: { type: String, default: 'Nenhuma atividade no período.' },
  personLabel: { type: String, default: 'Vendedor' },
});

const sortKey = ref(props.sortedBy);
const sortDirection = ref(
  /** @type {'descending'|'ascending'} */ ('descending'),
);
watch(
  () => props.sortedBy,
  (value) => {
    sortKey.value = value;
    sortDirection.value = 'descending';
  },
);

const sortedRows = computed(() => {
  /** @type {Row[]} */
  const rows = [.../** @type {Row[]} */ (props.rows)];
  if (!props.sortable || !sortKey.value) return rows;
  const key = sortKey.value;
  const factor = sortDirection.value === 'descending' ? -1 : 1;
  return rows.sort((a, b) => {
    const left = a.cells[key]?.value;
    const right = b.cells[key]?.value;
    const missingLeft = typeof left !== 'number';
    const missingRight = typeof right !== 'number';
    if (missingLeft || missingRight)
      return Number(missingLeft) - Number(missingRight);
    return (left - right) * factor || a.name.localeCompare(b.name, 'pt-BR');
  });
});

/** Share of the largest value, for the decorative meter only. */
const meterMax = computed(() => {
  /** @type {Record<string, number>} */
  const max = {};
  for (const column of /** @type {Column[]} */ (props.columns)) {
    if (!column.meter) continue;
    max[column.key] = Math.max(
      0,
      ...[...props.rows, ...props.extraRows].map((row) => {
        const value = /** @type {Row} */ (row).cells[column.key]?.value;
        return typeof value === 'number' ? value : 0;
      }),
    );
  }
  return max;
});

/** @param {Row} row @param {string} key */
function meterWidth(row, key) {
  const value = row.cells[key]?.value;
  const max = meterMax.value[key];
  if (typeof value !== 'number' || !max) return null;
  return `${Math.round((Math.max(0, value) / max) * 100)}%`;
}

/** @param {Column} column */
function ariaSort(column) {
  if (sortKey.value !== column.key) return column.sortable ? 'none' : undefined;
  return sortDirection.value;
}

/** @param {Column} column */
function toggleSort(column) {
  if (sortKey.value === column.key) {
    sortDirection.value =
      sortDirection.value === 'descending' ? 'ascending' : 'descending';
  } else {
    sortKey.value = column.key;
    sortDirection.value = 'descending';
  }
}

const allRows = computed(() => [
  ...sortedRows.value.map((row) => ({ row, kind: 'person' })),
  ...props.extraRows.map((row) => ({
    row: /** @type {Row} */ (row),
    kind: 'channel',
  })),
  ...(props.totalRow
    ? [{ row: /** @type {Row} */ (props.totalRow), kind: 'total' }]
    : []),
]);
</script>

<template>
  <div class="dashboard-team-table-wrap">
    <table class="dashboard-team-table" role="table">
      <caption class="sr-only">
        {{
          caption
        }}
      </caption>
      <thead role="rowgroup">
        <tr role="row">
          <th :id="`${idPrefix}-seller`" scope="col" role="columnheader">
            {{ personLabel }}
          </th>
          <th
            v-for="column in columns"
            :id="`${idPrefix}-${column.key}`"
            :key="column.key"
            scope="col"
            role="columnheader"
            :aria-sort="ariaSort(column)"
            :data-sorted="sortKey === column.key ? 'true' : undefined"
          >
            <button
              v-if="sortable && column.sortable"
              type="button"
              class="dashboard-sort"
              @click="toggleSort(column)"
            >
              {{ column.label
              }}<span class="dashboard-sort-mark" aria-hidden="true">{{
                sortKey === column.key
                  ? sortDirection === 'descending'
                    ? '↓'
                    : '↑'
                  : '↕'
              }}</span>
            </button>
            <template v-else>{{ column.label }}</template>
          </th>
        </tr>
      </thead>
      <tbody role="rowgroup">
        <tr v-if="!rows.length" role="row">
          <td
            :colspan="columns.length + 1"
            class="dashboard-table-empty"
            role="cell"
          >
            {{ emptyText }}
          </td>
        </tr>
        <tr
          v-for="(entry, index) in allRows"
          :key="`${entry.kind}-${entry.row.id}`"
          role="row"
          :class="{
            'dashboard-team-channel': entry.kind === 'channel',
            'dashboard-team-total': entry.kind === 'total',
          }"
        >
          <th
            :id="`${idPrefix}-person-${index}`"
            scope="row"
            role="rowheader"
            :headers="`${idPrefix}-seller`"
          >
            <span class="dashboard-person-name" :title="entry.row.name">{{
              entry.row.name
            }}</span
            ><span v-if="entry.row.note" class="dashboard-cell-note">{{
              entry.row.note
            }}</span>
          </th>
          <td
            v-for="column in columns"
            :key="column.key"
            :data-label="column.label"
            role="cell"
            :headers="`${idPrefix}-person-${index} ${idPrefix}-${column.key}`"
          >
            <span
              v-if="column.meter && entry.kind !== 'total'"
              class="dashboard-meter"
              aria-hidden="true"
              ><span
                v-if="meterWidth(entry.row, column.key)"
                :style="{ inlineSize: meterWidth(entry.row, column.key) }"
              ></span></span
            ><strong
              v-if="column.meter"
              :data-tone="entry.row.cells[column.key]?.tone || undefined"
              >{{ entry.row.cells[column.key]?.text ?? '—' }}</strong
            ><span
              v-else
              :data-tone="entry.row.cells[column.key]?.tone || undefined"
              >{{ entry.row.cells[column.key]?.text ?? '—' }}</span
            ><span
              v-if="entry.row.cells[column.key]?.note"
              class="dashboard-cell-note"
              >{{ entry.row.cells[column.key]?.note }}</span
            >
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
