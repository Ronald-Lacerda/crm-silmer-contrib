<script setup>
import { computed } from 'vue';

// Ícones de traço 24×24 no desenho do Lucide (ISC), o mesmo conjunto que o
// ReUI usa. Um só peso de traço para toda a navegação e o shell.
const ICONS = Object.freeze({
  dashboard: [
    'M4 3h5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z',
    'M15 3h5a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z',
    'M15 12h5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z',
    'M4 16h5a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z',
  ],
  inbox: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
  orders: [
    'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z',
    'M14 2v4a2 2 0 0 0 2 2h4',
    'M10 9H8',
    'M16 13H8',
    'M16 17H8',
  ],
  clients: [
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2',
    'M5 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0',
    'M22 21v-2a4 4 0 0 0-3-3.87',
    'M16 3.13a4 4 0 0 1 0 7.75',
  ],
  team: [
    'M15 15a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
    'M5 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0',
    'M10 15H6a4 4 0 0 0-4 4v2',
    'm21.7 16.4-.9-.3',
    'm15.2 13.9-.9-.3',
    'm16.6 18.7.3-.9',
    'm19.1 12.2.3-.9',
    'm19.6 18.7-.4-1',
    'm16.8 12.3-.4-1',
    'm14.3 16.6 1-.4',
    'm20.7 13.8 1-.4',
  ],
  account: [
    'M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0',
    'M9 10a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
    'M7 20.66V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.66',
  ],
  logout: [
    'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4',
    'M16 17l5-5-5-5',
    'M21 12H9',
  ],
  menu: ['M4 12h16', 'M4 6h16', 'M4 18h16'],
  close: ['M18 6 6 18', 'm6 6 12 12'],
  sun: [
    'M8 12a4 4 0 1 0 8 0a4 4 0 1 0-8 0',
    'M12 2v2',
    'M12 20v2',
    'm4.93 4.93 1.41 1.41',
    'm17.66 17.66 1.41 1.41',
    'M2 12h2',
    'M20 12h2',
    'm6.34 17.66-1.41 1.41',
    'm19.07 4.93-1.41 1.41',
  ],
  moon: ['M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z'],
  chevron: ['m9 18 6-6-6-6'],
  more: [
    'M11 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0',
    'M18 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0',
    'M4 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0',
  ],
  'chevron-down': ['m6 9 6 6 6-6'],
  back: ['m15 18-6-6 6-6'],
  panel: [
    'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    'M15 3v18',
  ],
  search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'm21 21-4.3-4.3'],
  check: ['M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0', 'm9 12 2 2 4-4'],
  maximize: ['M8 3H3v5', 'M16 3h5v5', 'M21 16v5h-5', 'M3 16v5h5'],
  download: [
    'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4',
    'm7 10 5 5 5-5',
    'M12 15V3',
  ],
  paperclip: [
    'm21.4 11.6-9.2 9.2a6 6 0 0 1-8.5-8.5l10-10a4 4 0 0 1 5.7 5.7l-10 10a2 2 0 0 1-2.8-2.8l9.2-9.2',
  ],
  play: ['m8 5 11 7-11 7z'],
  pause: ['M6 4h4v16H6z', 'M14 4h4v16h-4z'],
  volume: [
    'm11 5-6 4H2v6h3l6 4z',
    'M15.5 8.5a5 5 0 0 1 0 7',
    'M19 5a10 10 0 0 1 0 14',
  ],
  'volume-muted': ['m11 5-6 4H2v6h3l6 4z', 'm17 9 6 6', 'm23 9-6 6'],
  send: ['m22 2-7 20-4-9L2 9Z', 'M22 2 11 13'],
  mic: [
    'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0z',
    'M5 10v2a7 7 0 0 0 14 0v-2',
    'M12 19v3',
    'M8 22h8',
  ],
  square: [
    'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z',
  ],
  trash: ['M3 6h18', 'M8 6V4h8v2', 'M5 6l1 14h12l1-14', 'M10 10v6', 'M14 10v6'],
  truck: [
    'M1 3h14v14H1z',
    'M15 8h4l3 4v5h-7',
    'M5.5 17a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5',
    'M18.5 17a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5',
  ],
  bot: [
    'M12 3V1',
    'M8 3h8a4 4 0 0 1 4 4v11H4V7a4 4 0 0 1 4-4Z',
    'M1 10h3',
    'M20 10h3',
    'M8 9v2',
    'M16 9v2',
    'M9 14h6',
  ],
});

const props = defineProps({
  name: { type: String, required: true },
});

const paths = computed(() => ICONS[props.name] ?? []);
</script>

<template>
  <svg
    class="app-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path v-for="d in paths" :key="d" :d="d" />
  </svg>
</template>
