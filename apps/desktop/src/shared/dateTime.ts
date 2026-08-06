const TIMEZONE_SUFFIX_PATTERN = /(?:Z|[+-]\d{2}:?\d{2})$/i;

export function parseApiDateTime(value: string): Date {
  const trimmedValue = value.trim();
  const normalizedValue = TIMEZONE_SUFFIX_PATTERN.test(trimmedValue)
    ? trimmedValue
    : `${trimmedValue}Z`;
  return new Date(normalizedValue);
}
