const COUNTRY_CODE = "234"

// Remove spaces, dashes, dots and brackets people often type, e.g. "0803 123 4567"
const stripFormatting = (phone: string) => phone.replace(/[\s().-]/g, '')

// phone number validator
export const verifyPhoneNumber = (phone: string) => {
  return /^(?:\+?234|0)?([789][01])\d{8}$/.test(stripFormatting(phone));
};

export const sanitizePhoneNumber = (phone: string) => {
  if (!verifyPhoneNumber(phone)) {
    return {
      status: false,
      message: "Phone number is invalid",
      phone: ""
    };
  }

  phone = stripFormatting(phone);

  // Remove leading 0 or +
  if (phone.startsWith("0")) {
    phone = phone.substring(1);
  }
  if (phone.startsWith("+")) {
    phone = phone.substring(1);
  }

  // Remove country code if it exists
  if (phone.startsWith(COUNTRY_CODE)) {
    phone = phone.substring(COUNTRY_CODE.length);
  }

  // Add country code with + prefix
  return {
    status: true,
    message: "Phone number is valid",
    phone: `+${COUNTRY_CODE}${phone}`
  };
};

// Nigerian numbers in any common format become +234…; other countries must be given in international format.
export const normalizePhone = (input: string): string | null => {
  const nigerian = sanitizePhoneNumber(input);
  if (nigerian.status) return nigerian.phone;
  const stripped = stripFormatting(input);
  const international = stripped.startsWith('00') ? `+${stripped.slice(2)}` : stripped;
  return /^\+[1-9]\d{7,14}$/.test(international) ? international : null;
};
