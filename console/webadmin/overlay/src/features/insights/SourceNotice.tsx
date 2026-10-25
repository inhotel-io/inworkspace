/*
 * SPDX-FileCopyrightText: 2026 inWorkspace contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useTranslation } from 'react-i18next';

/** Where the source of this modified build is published; set when the build is made. */
const SOURCE_URL =
  (import.meta.env.VITE_INWORKSPACE_SOURCE_URL as string | undefined) ||
  'https://github.com/inhotel-io/inworkspace/tree/main/console/webadmin';

/**
 * This web admin is a modified version of Stalwart's web UI, licensed under the AGPL. Everyone who
 * uses it over the network is offered its source (AGPL-3.0, section 13).
 */
export function SourceNotice() {
  const { t } = useTranslation();
  return (
    <div className="border-t px-3 py-2 text-[11px] leading-snug text-muted-foreground">
      {t('insights.modifiedBuild', 'Modified by inWorkspace, under the AGPL.')}{' '}
      <a href={SOURCE_URL} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2 hover:text-foreground">
        {t('insights.source', 'Source')}
      </a>
    </div>
  );
}
