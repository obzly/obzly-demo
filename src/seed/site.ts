// The demo runs as a control plane with one Site. Site data calls go to
// /sites/<DEMO_SITE_ID>/api/v1/...; the demo router strips that prefix and
// passes req.siteId, so the same handlers answer central and Site calls.

export const DEMO_SITE_ID = 'harborline-eu';
export const DEMO_SITE_NAME = 'eu-west-1';
export const DEMO_SITE_DISPLAY_NAME = 'Harborline EU';
export const DEMO_SITE_ENVIRONMENT = 'production' as const;
export const DEMO_SITE_API_URL = 'https://obzly-eu.harborline.example.com';

/** True for a call proxied to a Site (/sites/:id/api/v1/...), false for the control plane's own. */
export const isSiteCall = (req: { siteId?: string }) => !!req.siteId;
