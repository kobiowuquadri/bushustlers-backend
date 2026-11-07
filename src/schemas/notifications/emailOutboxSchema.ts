import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import sequelize from '../../database/db.js';

// Delivery record for every email. The rendered HTML is only stored for emails captured by the
// local development mailbox; sent emails keep metadata only so tokens never sit in the database.
export class EmailOutbox extends Model<InferAttributes<EmailOutbox>, InferCreationAttributes<EmailOutbox>> {
  declare id: CreationOptional<number>;
  declare toEmail: string;
  declare subject: string;
  declare template: string;
  declare status: 'sent' | 'failed' | 'captured';
  declare html: CreationOptional<string | null>;
  declare error: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

EmailOutbox.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    toEmail: { type: DataTypes.STRING(255), allowNull: false },
    subject: { type: DataTypes.STRING(255), allowNull: false },
    template: { type: DataTypes.STRING(64), allowNull: false },
    status: { type: DataTypes.ENUM('sent', 'failed', 'captured'), allowNull: false },
    html: { type: DataTypes.TEXT('medium'), allowNull: true },
    error: { type: DataTypes.STRING(255), allowNull: true },
    createdAt: { type: DataTypes.DATE(3), allowNull: false },
    updatedAt: { type: DataTypes.DATE(3), allowNull: false },
  },
  { sequelize, modelName: 'EmailOutbox', tableName: 'email_outbox' },
);

export default EmailOutbox;
