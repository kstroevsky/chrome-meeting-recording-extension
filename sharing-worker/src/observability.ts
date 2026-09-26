type MetricValue = string | number | boolean;

export function sharingMetric(event: string, fields: Record<string, MetricValue> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}

export function observeSharingResponse(url: URL, response: Response): void {
  const operation = publicationOperation(url.pathname);
  if (operation && response.status >= 400) {
    sharingMetric('sharing_publication_request_failed', {
      operation,
      status: response.status,
    });
    if (operation === 'finalize') {
      sharingMetric('sharing_finalization_failed', { status: response.status });
    }
  }

  if (viewerSurface(url.pathname) && [401, 404, 410].includes(response.status)) {
    sharingMetric('sharing_viewer_authorization_failed', {
      surface: viewerSurface(url.pathname)!,
      status: response.status,
    });
  }
}

function publicationOperation(pathname: string): string | null {
  if (/^\/api\/shares\/[^/]+\/finalize$/.test(pathname)) return 'finalize';
  if (/^\/api\/shares\/[^/]+\/recordings\/[^/]+\/tracks\/[^/]+\/origin$/.test(pathname)) {
    return 'drive_origin';
  }
  if (/^\/api\/shares\/[^/]+\/revoke$/.test(pathname)) return 'revoke';
  if (/^\/api\/shares\/[^/]+$/.test(pathname)) return 'share_manifest';
  return null;
}

function viewerSurface(pathname: string): string | null {
  if (/^\/s\/[^/]+$/.test(pathname)) return 'capability';
  if (pathname === '/viewer') return 'viewer_shell';
  if (pathname === '/viewer/app.js') return 'viewer_app';
  if (pathname === '/viewer/manifest') return 'manifest';
  if (/^\/media\/recordings\/[^/]+\/tracks\/[^/]+$/.test(pathname)) return 'media';
  return null;
}
