/**
 * @file debug/renderers/SystemInfoReader.ts
 *
 * Reads GPU and hardware capability information for display in the debug
 * dashboard's system info panel.
 */

import { isTestRuntime } from '../../shared/build';

/** Reads vendor and renderer strings via WebGL debug extension when available. */
export function readWebGlInfo(): { vendor: string | null; renderer: string | null } {
  if (isTestRuntime()) return { vendor: null, renderer: null };
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) return { vendor: null, renderer: null };

    const webgl = gl as WebGLRenderingContext;
    const debugExt = webgl.getExtension('WEBGL_debug_renderer_info') as {
      UNMASKED_VENDOR_WEBGL: number;
      UNMASKED_RENDERER_WEBGL: number;
    } | null;

    if (debugExt) {
      return {
        vendor: String(webgl.getParameter(debugExt.UNMASKED_VENDOR_WEBGL) ?? ''),
        renderer: String(webgl.getParameter(debugExt.UNMASKED_RENDERER_WEBGL) ?? ''),
      };
    }

    return {
      vendor: null,
      renderer: String(webgl.getParameter(webgl.RENDERER) ?? ''),
    };
  } catch {
    return { vendor: null, renderer: null };
  }
}

/** Queries the WebGPU adapter for human-readable hardware description. */
export async function readWebGpuInfo(): Promise<string | null> {
  try {
    const gpu = (navigator as Navigator & { gpu?: any }).gpu;
    if (!gpu?.requestAdapter) return null;
    const adapter = await gpu.requestAdapter();
    if (!adapter) return null;

    const info = await adapter.requestAdapterInfo?.().catch?.(() => null);
    if (info) {
      const parts = [info.vendor, info.architecture, info.device, info.description].filter(Boolean);
      if (parts.length) return parts.join(' / ');
    }

    return adapter.name ?? null;
  } catch {
    return null;
  }
}

/** Collects all system info lines into a display-ready multi-line string. */
export async function buildSystemInfoText(): Promise<string> {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const lines = [
    'True system CPU/GPU utilization is not exposed by Chrome extension APIs.',
    'CPU pressure in this dashboard is approximated with event-loop lag and long-task counts.',
    `Hardware threads: ${typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : 'n/a'}`,
    `Device memory: ${typeof nav.deviceMemory === 'number' ? nav.deviceMemory + ' GB' : 'n/a'}`,
  ];

  const webGlInfo = readWebGlInfo();
  lines.push(`WebGL vendor: ${webGlInfo.vendor ?? 'n/a'}`);
  lines.push(`WebGL renderer: ${webGlInfo.renderer ?? 'n/a'}`);

  const webGpuInfo = await readWebGpuInfo();
  lines.push(webGpuInfo ? `WebGPU adapter: ${webGpuInfo}` : 'WebGPU adapter: unavailable');

  return lines.join('\n');
}
