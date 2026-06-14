/**
 * @file platform/capabilities/auth/createAuthProvider.ts
 *
 * Composition root for the auth capability (ADR-0002). The only place a concrete
 * AuthProvider is selected. Chrome's getAuthToken is preferred where it exists
 * (it ties tokens to the browser's Google sign-in); every other browser falls
 * back to the standard launchWebAuthFlow OAuth2 flow.
 *
 * Selection is by runtime capability today. A build-target override
 * (target=edge -> WebAuthFlow, for browsers where getAuthToken exists but does
 * not function) is added in Phase 0 step 2.
 */

import type { AuthProvider } from '../AuthProvider';
import { ChromeIdentityAuthProvider } from './ChromeIdentityAuthProvider';
import { WebAuthFlowAuthProvider } from './WebAuthFlowAuthProvider';
import { getRedirectURL, launchWebAuthFlow } from '../../chrome/identity';

const DRIVE_OAUTH_SCOPES = ['https://www.googleapis.com/auth/drive.file'];

function getWebOAuthClientId(): string {
  // Wired by the per-browser build target (ADR-0002, Phase 0 step 2); empty until
  // then, which makes WebAuthFlowAuthProvider.getToken fail fast with a clear
  // "not configured" error rather than starting a broken OAuth flow.
  return (globalThis as { __WEB_OAUTH_CLIENT_ID__?: string }).__WEB_OAUTH_CLIENT_ID__ ?? '';
}

function chromeIdentityTokenSupported(): boolean {
  return typeof chrome !== 'undefined' && typeof chrome.identity?.getAuthToken === 'function';
}

export function createAuthProvider(): AuthProvider {
  if (chromeIdentityTokenSupported()) {
    return new ChromeIdentityAuthProvider();
  }
  return new WebAuthFlowAuthProvider(
    {
      clientId: getWebOAuthClientId(),
      scopes: DRIVE_OAUTH_SCOPES,
      redirectUri: getRedirectURL(),
    },
    launchWebAuthFlow
  );
}
