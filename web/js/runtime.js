/**
 * 运行环境开关。
 * 桌面版保持 false；平板离线版在页面加载前设置 window.__SHUATI_OFFLINE__ = true。
 */
export const OFFLINE_MODE =
  typeof window !== 'undefined' && window.__SHUATI_OFFLINE__ === true;

/** Capacitor 打包后的 App 会注入 window.Capacitor。 */
export function isNativeApp() {
  return typeof window !== 'undefined' && Boolean(window.Capacitor?.isNativePlatform?.());
}

