import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../../database/db.js";

// This is the attributes for the Auth (user account) model
export interface AuthAttributes {
    id: number;
    email: string;
    password: string;
    fullName: string | null;
    emailVerifiedAt: Date | null;
    passwordChangedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

// This is the creation attributes for the Auth model
export interface AuthCreationAttributes extends Optional<AuthAttributes, "id" | "fullName" | "emailVerifiedAt" | "passwordChangedAt" | "createdAt" | "updatedAt"> {}

// This is the model for the Auth model. Refresh tokens now live in auth_sessions (one row per signed-in device).
export class Auth extends Model<AuthAttributes, AuthCreationAttributes> implements AuthAttributes {
    declare id: number;
    declare email: string;
    declare password: string;
    declare fullName: string | null;
    declare emailVerifiedAt: Date | null;
    declare passwordChangedAt: Date | null;
    declare createdAt: Date;
    declare updatedAt: Date;
}

// This is the schema for the Auth model (created by migration 20261107-0001)
export const AuthSchema = {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    email: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
    },
    password: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    fullName: {
        type: DataTypes.STRING(120),
        allowNull: true,
    },
    emailVerifiedAt: {
        type: DataTypes.DATE(3),
        allowNull: true,
    },
    passwordChangedAt: {
        type: DataTypes.DATE(3),
        allowNull: true,
    },
    createdAt: {
        type: DataTypes.DATE(3),
        allowNull: false,
        defaultValue: DataTypes.NOW,
    },
    updatedAt: {
        type: DataTypes.DATE(3),
        allowNull: false,
        defaultValue: DataTypes.NOW,
    },
} as const;

// Initialize and export the Sequelize model instance
Auth.init(AuthSchema, {
    sequelize,
    modelName: "Auth",
    tableName: "auths",
});

export { Auth as default };
