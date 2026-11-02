<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import AppShell from './app/layouts/AppShell.vue'
import ReaderLayout from './app/layouts/ReaderLayout.vue'

const route = useRoute()

// 阅读页使用独立布局：没有侧栏、顶栏可自动隐藏，且必须占满视口。
const isReader = computed(() => route.name === 'reader')
</script>

<template>
  <ReaderLayout v-if="isReader" />
  <AppShell v-else />
</template>
