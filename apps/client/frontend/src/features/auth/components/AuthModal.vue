<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'

const emit = defineEmits<{
  close: []
  success: []
}>()

const { t } = useI18n()
const auth = useAuthStore()

// ★ 只有登录：本产品不提供公开注册。账号由运维在服务器上执行
//   `api createuser --email ...` 创建，服务端连注册路由都不注册。
//   不要在这里加回「注册」页签——那会引导用户去点一个必然 404 的入口。
const email = ref('')
const password = ref('')
const errorMessage = ref<string | null>(null)
const submitting = ref(false)

async function handleSubmit(): Promise<void> {
  if (!email.value || !password.value) return
  submitting.value = true
  errorMessage.value = null
  try {
    await auth.login(email.value.trim(), password.value)
    emit('success')
    emit('close')
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
    <div
      class="w-full max-w-sm rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-6 shadow-2xl space-y-5"
    >
      <div class="flex items-center justify-between">
        <div class="text-base font-bold text-[var(--color-text-primary)] border-b-2 border-[var(--color-accent)] pb-0.5">
          {{ t('auth.login') }}
        </div>
        <button
          type="button"
          class="rounded p-1 text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] transition"
          @click="emit('close')"
        >
          ✕
        </button>
      </div>

      <div v-if="errorMessage" class="rounded-lg bg-red-500/10 border border-red-500/20 p-2.5 text-xs text-red-600 dark:text-red-400">
        {{ errorMessage }}
      </div>

      <form class="space-y-3.5" @submit.prevent="handleSubmit">
        <div class="space-y-1">
          <label class="block text-xs font-medium text-[var(--color-text-secondary)]">{{ t('auth.email') }}</label>
          <input
            v-model="email"
            type="email"
            required
            autocomplete="username"
            class="w-full rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)]"
            placeholder="you@example.com"
          />
        </div>

        <div class="space-y-1">
          <label class="block text-xs font-medium text-[var(--color-text-secondary)]">{{ t('auth.password') }}</label>
          <input
            v-model="password"
            type="password"
            required
            autocomplete="current-password"
            class="w-full rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)]"
            placeholder="••••••••"
          />
        </div>

        <button
          type="submit"
          :disabled="submitting"
          class="w-full rounded-xl bg-[var(--color-accent)] py-2 text-sm font-semibold text-white shadow-sm hover:opacity-90 active:scale-[0.99] transition disabled:opacity-50"
        >
          {{ submitting ? t('auth.submitting') : t('auth.login') }}
        </button>
      </form>

      <!-- 没有注册入口，必须说清楚账号从哪来，否则用户只会卡在这一步 -->
      <p class="text-xs leading-relaxed text-[var(--color-text-tertiary)]">
        {{ t('auth.noSelfRegister') }}
      </p>
    </div>
  </div>
</template>
