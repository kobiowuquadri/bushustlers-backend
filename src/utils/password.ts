import bcrypt from 'bcryptjs'

const SALT_ROUNDS = 10

// bcrypt ignores everything after the first 72 bytes of a password
export const PASSWORD_MAX_BYTES = 72

// hash password
export const hashPassword = async (password: string) => {
  return await bcrypt.hash(password, SALT_ROUNDS)
}

// verify password
export const verifyPassword = async (password: string, hashedPassword: string) => {
  return await bcrypt.compare(password, hashedPassword)
}

// At least 8 characters with a lowercase letter, an uppercase letter, a digit and any symbol
export const passwordValidator = (value: string) => {
  const criteria = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,}$/
  return criteria.test(value) && Buffer.byteLength(value) <= PASSWORD_MAX_BYTES
}
