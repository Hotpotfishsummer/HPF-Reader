<script setup lang="ts">
import { RouterView } from 'vue-router'
</script>

<template>
  <!--
    阅读区必须是 absolute inset-0 这样的确定尺寸容器：
    foliate-paginator 用 ResizeObserver 监听容器尺寸，高度为 0 时会算出 0 页 / 白屏。
    隐藏阅读区时也要用 v-show 而不是 v-if（等容器恢复尺寸后再排版）。
  -->
  <div class="absolute inset-0 overflow-hidden bg-[var(--reader-paper)]">
    <RouterView />
  </div>
</template>
