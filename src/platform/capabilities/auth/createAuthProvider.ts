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

function getBrowserTarget(): string {
  if (typeof __BROWSER_TARGET__ !== 'undefined' && __BROWSER_TARGET__) return __BROWSER_TARGET__;
  return (globalThis as { __BROWSER_TARGET__?: string }).__BROWSER_TARGET__ ?? 'chrome';
}

function getWebOAuthClientId(): string {
  if (typeof __WEB_OAUTH_CLIENT_ID__ !== 'undefined' && __WEB_OAUTH_CLIENT_ID__) return __WEB_OAUTH_CLIENT_ID__;
  return (globalThis as { __WEB_OAUTH_CLIENT_ID__?: string }).__WEB_OAUTH_CLIENT_ID__ ?? '';
}

function chromeIdentityTokenSupported(): boolean {
  return typeof chrome !== 'undefined' && typeof chrome.identity?.getAuthToken === 'function';
}

export function createAuthProvider(): AuthProvider {
  // chrome.identity.getAuthToken only works on Chrome itself; every other
  // Chromium target uses launchWebAuthFlow. The build target decides, with a
  // runtime capability guard so a Chrome build lacking getAuthToken still falls
  // back rather than crashing.
  if (getBrowserTarget() === 'chrome' && chromeIdentityTokenSupported()) {
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
