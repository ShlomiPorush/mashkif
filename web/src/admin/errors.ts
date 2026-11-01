/**
 * Maps server error codes (Mashkif's snake_case codes and Better Auth's
 * UPPER_CASE codes) to locale keys under "errors". Unknown codes get a
 * generic message; an answer without a status never reached the server.
 */
export const ERROR_KEYS = {
  invalidCredentials: "errors.invalidCredentials",
  invalidCode: "errors.invalidCode",
  signInExpired: "errors.signInExpired",
  locked: "errors.locked",
  tooManyAttempts: "errors.tooManyAttempts",
  wrongPassword: "errors.wrongPassword",
  passwordTooShort: "errors.passwordTooShort",
  passwordTooLong: "errors.passwordTooLong",
  passwordsDiffer: "errors.passwordsDiffer",
  usernameInvalid: "errors.usernameInvalid",
  setupTokenInvalid: "errors.setupTokenInvalid",
  alreadySetUp: "errors.alreadySetUp",
  resetTokenInvalid: "errors.resetTokenInvalid",
  resetTokenExpired: "errors.resetTokenExpired",
  resetTokenUsed: "errors.resetTokenUsed",
  passkeyUserVerification: "errors.passkeyUserVerification",
  passkeyCancelled: "errors.passkeyCancelled",
  passkeyFailed: "errors.passkeyFailed",
  passkeyRegistered: "errors.passkeyRegistered",
  sessionEnded: "errors.sessionEnded",
  originRejected: "errors.originRejected",
  busy: "errors.busy",
  network: "errors.network",
  unexpected: "errors.unexpected",
  labelInvalid: "errors.labelInvalid",
  validityInvalid: "errors.validityInvalid",
  keyNotRevocable: "errors.keyNotRevocable",
  tierInvalid: "errors.tierInvalid",
  areaInvalid: "errors.areaInvalid",
  areaOutside: "errors.areaOutside",
  agentRevoked: "errors.agentRevoked",
  rangeInvalid: "errors.rangeInvalid",
  rangeExists: "errors.rangeExists",
  noteInvalid: "errors.noteInvalid",
  nameInvalid: "errors.nameInvalid",
  asnsInvalid: "errors.asnsInvalid",
  asnTaken: "errors.asnTaken",
  providerExists: "errors.providerExists",
  settingInvalid: "errors.settingInvalid",
  notFound: "errors.notFound",
  conflict: "errors.conflict",
} as const;

export type ErrorKey = (typeof ERROR_KEYS)[keyof typeof ERROR_KEYS];

const BY_CODE: Record<string, ErrorKey> = {
  invalid_username_or_password: ERROR_KEYS.invalidCredentials,
  invalid_code: ERROR_KEYS.invalidCode,
  invalid_two_factor_cookie: ERROR_KEYS.signInExpired,
  too_many_attempts_request_new_code: ERROR_KEYS.signInExpired,
  account_temporarily_locked: ERROR_KEYS.locked,
  too_many_attempts: ERROR_KEYS.tooManyAttempts,
  invalid_password: ERROR_KEYS.wrongPassword,
  password_too_short: ERROR_KEYS.passwordTooShort,
  password_too_long: ERROR_KEYS.passwordTooLong,
  username_invalid: ERROR_KEYS.usernameInvalid,
  setup_token_invalid: ERROR_KEYS.setupTokenInvalid,
  already_set_up: ERROR_KEYS.alreadySetUp,
  reset_token_invalid: ERROR_KEYS.resetTokenInvalid,
  reset_token_expired: ERROR_KEYS.resetTokenExpired,
  reset_token_used: ERROR_KEYS.resetTokenUsed,
  passkey_user_verification_required: ERROR_KEYS.passkeyUserVerification,
  auth_cancelled: ERROR_KEYS.passkeyCancelled,
  error_ceremony_aborted: ERROR_KEYS.passkeyCancelled,
  passkey_not_found: ERROR_KEYS.passkeyFailed,
  authentication_failed: ERROR_KEYS.passkeyFailed,
  challenge_not_found: ERROR_KEYS.passkeyFailed,
  failed_to_verify_registration: ERROR_KEYS.passkeyFailed,
  error_authenticator_previously_registered: ERROR_KEYS.passkeyRegistered,
  session_required: ERROR_KEYS.sessionEnded,
  session_ended: ERROR_KEYS.sessionEnded,
  totp_required: ERROR_KEYS.sessionEnded,
  origin_rejected: ERROR_KEYS.originRejected,
  busy: ERROR_KEYS.busy,
  network: ERROR_KEYS.network,
  label_invalid: ERROR_KEYS.labelInvalid,
  valid_hours_invalid: ERROR_KEYS.validityInvalid,
  enrollment_key_not_revocable: ERROR_KEYS.keyNotRevocable,
  trust_tier_invalid: ERROR_KEYS.tierInvalid,
  area_cell_invalid: ERROR_KEYS.areaInvalid,
  area_outside_service_area: ERROR_KEYS.areaOutside,
  agent_revoked: ERROR_KEYS.agentRevoked,
  range_invalid: ERROR_KEYS.rangeInvalid,
  range_exists: ERROR_KEYS.rangeExists,
  note_invalid: ERROR_KEYS.noteInvalid,
  name_invalid: ERROR_KEYS.nameInvalid,
  asns_invalid: ERROR_KEYS.asnsInvalid,
  asn_taken: ERROR_KEYS.asnTaken,
  provider_exists: ERROR_KEYS.providerExists,
  setting_invalid: ERROR_KEYS.settingInvalid,
  not_found: ERROR_KEYS.notFound,
  conflict: ERROR_KEYS.conflict,
};

export function errorKey(code: string | undefined, status: number | undefined): ErrorKey {
  if (status === undefined || status === 0) {
    return ERROR_KEYS.network;
  }
  const known = code === undefined ? undefined : BY_CODE[code.toLowerCase()];
  if (known !== undefined) {
    return known;
  }
  return status === 429 ? ERROR_KEYS.tooManyAttempts : ERROR_KEYS.unexpected;
}

/** The locale key for an error from the Better Auth client. */
export function authErrorKey(failure: { status?: number | undefined }): ErrorKey {
  const code = (failure as { code?: unknown }).code;
  return errorKey(typeof code === "string" ? code : undefined, failure.status);
}
