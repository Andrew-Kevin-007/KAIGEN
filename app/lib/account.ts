/** A NEAR account id: 2 to 64 characters, dot-separated parts of lowercase letters and digits with single - or _ inside. */
const ACCOUNT_ID = /^(?=.{2,64}$)([a-z\d]+([-_][a-z\d]+)*\.)*[a-z\d]+([-_][a-z\d]+)*$/;

export const isAccountId = (v: unknown): v is string => typeof v === "string" && ACCOUNT_ID.test(v);
