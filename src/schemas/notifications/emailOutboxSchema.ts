import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import sequelize from '../../database/db.js';

export type EmailStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'captured';

// Email delivery queue. Requests only insert a "queued" row; a background worker sends it with retries.
// The rendered HTML (which can contain single-use links) is cleared once the email is sent or gives up;
// it is only kept for emails captured by the local development mailbox.
export class EmailOutbox extends Model<InferAttributes<EmailOutbox>, InferCreationAttributes<EmailOutbox>> {
  declare id: CreationOptional<number>;
  declare toEmail: string;
  declare subject: string;
  declare template: string;
  declare status: CreationOptional<EmailStatus>;
  declare html: CreationOptional<string | null>;
  declare error: CreationOptional<string | null>;
  declare attempts: CreationOptional<number>;
  declare nextAttemptAt: CreationOptional<Date | null>;
  declare sentAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

EmailOutbox.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    toEmail: { type: DataTypes.STRING(255), allowNull: false },
    subject: { type: DataTypes.STRING(255), allowNull: false },
    template: { type: DataTypes.STRING(64), allowNull: false },
    status: { type: DataTypes.ENUM('queued', 'sending', 'sent', 'failed', 'captured'), allowNull: false, defaultValue: 'queued' },
    html: { type: DataTypes.TEXT('medium'), allowNull: true },
    error: { type: DataTypes.STRING(255), allowNull: true },
    attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    nextAttemptAt: { type: DataTypes.DATE(3), allowNull: true },
    sentAt: { type: DataTypes.DATE(3), allowNull: true },
    createdAt: { type: DataTypes.DATE(3), allowNull: false },
    updatedAt: { type: DataTypes.DATE(3), allowNull: false },
  },
  { sequelize, modelName: 'EmailOutbox', tableName: 'email_outbox' },
);

export default EmailOutbox;
