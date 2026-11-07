import type { Schema } from 'express-validator';
import { passwordValidator } from '../../utils/index.js';

const email: Schema[string] = {
    in: ['body'],
    trim: true,
    isEmail: {
        errorMessage: 'Enter a valid email address',
    },
    isLength: { options: { max: 255 }, errorMessage: 'Email is too long' },
    toLowerCase: true,
};

const newPassword = (field: string): Schema[string] => ({
    in: ['body'],
    isString: {
        errorMessage: 'Invalid password',
        bail: true,
    },
    custom: {
        options: (value: string) => passwordValidator(value),
        errorMessage: 'Use 8-72 characters with an uppercase letter, a lowercase letter, a number and a symbol',
    },
});

const token: Schema[string] = {
    in: ['body'],
    isString: { errorMessage: 'Invalid link', bail: true },
    trim: true,
    matches: { options: [/^[A-Za-z0-9_-]{20,100}$/], errorMessage: 'Invalid link' },
};

const fullName: Schema[string] = {
    in: ['body'],
    isString: { errorMessage: 'Enter your name', bail: true },
    trim: true,
    isLength: { options: { min: 2, max: 120 }, errorMessage: 'Enter your full name (2-120 characters)' },
};

export const registerValidation: Schema = {
    fullName,
    email,
    password: newPassword('password'),
}

export const loginValidation: Schema = {
    email,
    password: {
        in: ['body'],
        isString: {
            errorMessage: 'Invalid password',
        },
        notEmpty: {
            errorMessage: 'Password is required',
        },
        isLength: { options: { max: 200 }, errorMessage: 'Invalid password' },
    }
}

export const updateProfileValidation: Schema = {
    fullName,
}

export const verifyEmailValidation: Schema = {
    token,
}

export const forgotPasswordValidation: Schema = {
    email,
}

export const resetPasswordValidation: Schema = {
    token,
    password: newPassword('password'),
}

export const changePasswordValidation: Schema = {
    currentPassword: {
        in: ['body'],
        isString: { errorMessage: 'Enter your current password', bail: true },
        notEmpty: { errorMessage: 'Enter your current password' },
    },
    newPassword: {
        ...newPassword('newPassword'),
        custom: {
            options: (value: string, { req }) => {
                if (!passwordValidator(value)) throw new Error('Use 8-72 characters with an uppercase letter, a lowercase letter, a number and a symbol');
                if (value === req.body.currentPassword) throw new Error('Choose a password you have not used for this account');
                return true;
            },
        },
    },
}
