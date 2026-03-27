/**
 * @module models/ChatHistory
 * @description ChatHistory model — stores conversation messages per session.
 */

const { DataTypes } = require('sequelize');

/**
 * Define the ChatHistory model.
 * @param {import('sequelize').Sequelize} sequelize - Sequelize instance
 * @returns {import('sequelize').Model} ChatHistory model
 */
module.exports = (sequelize) => {
  const ChatHistory = sequelize.define('ChatHistory', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    sessionId: {
      type: DataTypes.STRING(100),
      allowNull: false,
      field: 'session_id',
    },
    role: {
      type: DataTypes.STRING(20),
      allowNull: false,
      validate: {
        isIn: [['user', 'assistant']],
      },
    },
    content: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    sourceChunks: {
      type: DataTypes.JSONB,
      defaultValue: null,
      field: 'source_chunks',
    },
    confidenceScore: {
      type: DataTypes.FLOAT,
      field: 'confidence_score',
    },
  }, {
    tableName: 'chat_history',
    underscored: true,
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
    indexes: [
      { fields: ['session_id'] },
      { fields: ['session_id', 'created_at'] },
    ],
  });

  return ChatHistory;
};
