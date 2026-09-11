import { config } from '@avail/shared/config';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const VALID_ISSUERS = new Set([
  'https://accounts.google.com',
  'accounts.google.com',
]);

export class GoogleError extends Error {}

/** The subset of Google's ID token claims this platform relies on. */
export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
  /** Google Workspace hosted domain, when the account belongs to one. */
  hostedDomain: string | null;
}

interface IdTokenClaims {
  iss?: string;
  aud?: string;
  sub?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  picture?: string;
  hd?: string;
  exp?: number;
}

function decodeJwtPayload(token: string): IdTokenClaims {
  const payload = token.split('.')[1];
  if (!payload) throw new GoogleError('Malformed ID token');
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new GoogleError('ID token payload is not valid JSON');
  }
}

export const google = {
  get configured(): boolean {
    return Boolean(config.google.clientId && config.google.clientSecret);
  },

  /**
   * Google's consent screen URL.
   *
   * When exactly one domain is allow-listed we pass it as the `hd` hint, so
   * Workspace users land straight on their work account instead of picking
   * from every Google account they are signed into. It is only a hint — the
   * email domain is still enforced when the callback comes back.
   */
  authorizeUrl(redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      client_id: config.google.clientId ?? '',
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      access_type: 'online',
      prompt: 'select_account',
    });
    if (config.allowedEmailDomains.length === 1) {
      params.set('hd', config.allowedEmailDomains[0]);
    }
    return `${AUTH_ENDPOINT}?${params}`;
  },

  /**
   * Exchanges the callback code for the caller's identity.
   *
   * The ID token is fetched over a direct TLS connection to Google's token
   * endpoint rather than through the browser, so OIDC Core §3.1.3.7 allows
   * TLS server validation in place of verifying the token signature. The
   * claims themselves are still checked below.
   */
  async exchangeCode(code: string, redirectUri: string): Promise<GoogleIdentity> {
    if (!this.configured) {
      throw new GoogleError('Google sign-in is not configured');
    }

    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: config.google.clientId!,
        client_secret: config.google.clientSecret!,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    const body = (await response.json().catch(() => ({}))) as {
      id_token?: string;
      error?: string;
      error_description?: string;
    };

    if (!response.ok || !body.id_token) {
      throw new GoogleError(
        body.error_description ?? body.error ?? 'Google rejected the sign-in'
      );
    }

    const claims = decodeJwtPayload(body.id_token);

    if (!claims.iss || !VALID_ISSUERS.has(claims.iss)) {
      throw new GoogleError('ID token came from an unexpected issuer');
    }
    if (claims.aud !== config.google.clientId) {
      throw new GoogleError('ID token was issued for a different application');
    }
    if (!claims.exp || claims.exp * 1000 < Date.now()) {
      throw new GoogleError('ID token has expired');
    }
    if (!claims.email) {
      throw new GoogleError('Google did not return an email address');
    }
    // An unverified address proves nothing about who is signing in.
    if (claims.email_verified !== true && claims.email_verified !== 'true') {
      throw new GoogleError(`${claims.email} is not a verified Google address`);
    }

    return {
      sub: claims.sub ?? '',
      email: claims.email,
      emailVerified: true,
      name: claims.name ?? null,
      picture: claims.picture ?? null,
      hostedDomain: claims.hd ?? null,
    };
  },
};
