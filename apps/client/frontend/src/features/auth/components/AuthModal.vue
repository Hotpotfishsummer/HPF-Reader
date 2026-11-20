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

const mode = ref<'login' | 'register'>('login')
const email = ref('')
const password = ref('')
const displayName = ref('')
const errorMessage = ref<string | null>(null)
const submitting = ref(false)

async function handleSubmit(): Promise<void> {
  if (!email.value || !password.value) return
  submitting.value = true
  errorMessage.value = null
  try {
    if (mode.value === 'login') {
      await auth.login(email.value.trim(), password.value)
    } else {
      await auth.register(email.value.trim(), password.value, displayName.value.trim() || undefined)
    }
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
        <div class="flex items-center gap-3">
          <button
            type="button"
            class="text-base font-bold transition"
            :class="mode === 'login' ? 'text-[var(--color-text-primary)] border-b-2 border-[var(--color-accent)] pb-0.5' : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'"
            @click="mode = 'login'; errorMessage = null"
          >
            {{ t('auth.login') }}
          </button>
          <button
            type="button"
            class="text-base font-bold transition"
            :class="mode === 'register' ? 'text-[var(--color-text-primary)] border-b-2 border-[var(--color-accent)] pb-0.5' : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'"
            @click="mode = 'register'; errorMessage = null"
          >
            {{ t('auth.register') }}
          </button>
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
        <div v-if="mode === 'register'" class="space-y-1">
          <label class="block text-xs font-medium text-[var(--color-text-secondary)]">{{ t('auth.displayName') }}</label>
          <input
            v-model="displayName"
            type="text"
            class="w-full rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)]"
            :placeholder="t('auth.displayNamePlaceholder')"
          />
        </div>

        <div class="space-y-1">
          <label class="block text-xs font-medium text-[var(--color-text-secondary)]">{{ t('auth.email') }}</label>
          <input
            v-model="email"
            type="email"
            required
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
            class="w-full rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)]"
            placeholder="••••••••"
          />
        </div>

        <button
          type="submit"
          :disabled="submitting"
          class="w-full rounded-xl bg-[var(--color-accent)] py-2 text-sm font-semibold text-white shadow-sm hover:opacity-90 active:scale-[0.99] transition disabled:opacity-50"
        >
          {{ submitting ? t('auth.submitting') : (mode === 'login' ? t('auth.login') : t('auth.register')) }}
        </button>
      </form>
    </div>
  </div>
</template>
