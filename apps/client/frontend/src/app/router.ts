import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'

// 桌面宿主是自定义协议 / 自定义 scheme，Web 目标可能是子路径部署；
// 统一用 hash 路由，避免两种宿主的 base 差异。
const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'library',
    component: () => import('@/features/library/LibraryView.vue'),
  },
  {
    path: '/discover',
    name: 'discover',
    component: () => import('@/features/discover/DiscoverView.vue'),
  },
  {
    path: '/reader/:bookId',
    name: 'reader',
    component: () => import('@/reader/ReaderView.vue'),
    props: true,
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('@/features/settings/SettingsView.vue'),
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
})
