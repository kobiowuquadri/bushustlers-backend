export interface RegisterRequest {
    fullName: string;
    email: string;
    password: string;
}

export interface LoginRequest {
    email: string;
    password: string;
}

export interface ResetPasswordRequest {
    token: string;
    password: string;
}

export interface ChangePasswordRequest {
    currentPassword: string;
    newPassword: string;
}

export interface ClientInfo {
    ip?: string;
    userAgent?: string;
}

// The only user fields the API ever returns
export interface UserResponse {
    id: number;
    email: string;
    fullName: string | null;
    emailVerified: boolean;
    createdAt: Date;
}

// Delivered to the browser only as HttpOnly cookies, never in a response body
export interface SessionTokens {
    accessToken: string;
    // null when an access token is re-issued within the rotation grace window
    refreshToken: string | null;
    sessionExpiresAt: Date;
}
