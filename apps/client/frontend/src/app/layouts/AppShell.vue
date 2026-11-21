<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
</script>

<template>
  <div class="flex h-full flex-col bg-[var(--color-surface)] text-[var(--color-text-primary)]">
    <header
      class="flex shrink-0 items-center gap-6 border-b border-[var(--color-border-subtle)] px-6 py-3"
    >
      <span class="text-sm font-semibold tracking-wide">{{ t('app.name') }}</span>
      <nav class="flex gap-4 text-sm">
        <RouterLink
          to="/"
          class="hpf-press hpf-focus rounded px-2 py-1 text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)]"
          active-class="!text-[var(--color-text-primary)] font-medium"
        >
          {{ t('app.library') }}
        </RouterLink>
        <RouterLink
          to="/settings"
          class="hpf-press hpf-focus rounded px-2 py-1 text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)]"
          active-class="!text-[var(--color-text-primary)] font-medium"
        >
          {{ t('app.settings') }}
        </RouterLink>
      </nav>
    </header>

    <main class="min-h-0 flex-1 overflow-auto">
      <!--
        ★ 这里刻意**不做**路由过渡。两个静态流内的页面同时存在时会上下叠一格
        （旧页还在离场、新页已经入场），看起来是"整页跳一下"，
        比直接切换更难看。页面入场交给各自的 `.hpf-rise-in`（错峰淡入）。
      -->
      <RouterView />
    </main>
  </div>
</template>
