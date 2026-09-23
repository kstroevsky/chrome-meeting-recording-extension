declare const __E2E_MOCK_CAPTURE_BUILD__: boolean | undefined;
declare const __E2E_MOCK_DRIVE_BUILD__: boolean | undefined;
declare const __E2E_MOCK_ANALYSIS_BUILD__: boolean | undefined;
declare const __E2E_REAL_CAPTURE_TAB_BUILD__: boolean | undefined;
/** Compile-time gate for the development-only popup gallery preview adapter. */
declare const __POPUP_GALLERY_BUILD__: boolean;
// Cross-browser build target + its Web OAuth client (ADR-0002), injected by webpack.
declare const __BROWSER_TARGET__: string | undefined;
declare const __WEB_OAUTH_CLIENT_ID__: string | undefined;
declare const __WEB_OAUTH_CLIENT_SECRET__: string | undefined;
/** Exact HTTPS telemetry ingestion endpoint injected by webpack. */
declare const __TELEMETRY_ENDPOINT__: string;
/**
 * The embedding model this build packaged, injected by webpack from the same
 * manifest the fetcher verified. Read through `analysisEngineConfig()` rather
 * than directly, so a context without the define (a unit test) still works.
 */
declare const __ANALYSIS_MODEL__: { id: string; revision: string; dtype: string } | undefined;
