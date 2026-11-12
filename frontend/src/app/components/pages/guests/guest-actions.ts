import { HttpContext } from '@angular/common/http';
import { Service, inject } from '@angular/core';
import { ShareAccess, SharingService } from '@apps/drawboard-api';
import { firstValueFrom } from 'rxjs';

import { ERRORS_HANDLED_LOCALLY } from '../../../services/error-interceptor';
import { WithSpan } from '../../../util/tracing';

/**
 * Opening a share link. The span carries no attributes at all: the link token, the password
 * and the guest name are secrets or personal data and must not reach telemetry (S5.7, S7.2).
 * Every failure is shown by the join page itself (ERRORS_HANDLED_LOCALLY: no toast, no login
 * redirect), so the ApiError is thrown to it.
 */
@Service()
export class GuestActions {
  private readonly sharingApi = inject(SharingService);

  @WithSpan('GuestActions.exchange')
  exchange(token: string, password?: string, guestName?: string): Promise<ShareAccess> {
    const context = new HttpContext().set(ERRORS_HANDLED_LOCALLY, true);
    return firstValueFrom(
      this.sharingApi.exchangeShareToken(
        { shareExchange: { token, password, guestName } },
        'body',
        false,
        { context },
      ),
    );
  }
}
