/**
 * @module models/ChatSession
 * @description ChatSession model — stores chat session metadata per user.
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const ChatSession = sequelize.define('ChatSession', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: 'user_id',
      references: { model: 'users', key: 'id' },
    },
    title: {
      type: DataTypes.STRING(255),
      defaultValue: 'New conversation',
    },
    caseFilter: {
      type: DataTypes.STRING(255),
      field: 'case_filter',
    },
  }, {
    tableName: 'chat_sessions',
    underscored: true,
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['user_id', 'updated_at'] },
    ],
  });

  ChatSession.associate = (models) => {
    ChatSession.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
    ChatSession.hasMany(models.ChatHistory, { foreignKey: 'session_id', sourceKey: 'id', as: 'messages' });
  };

  return ChatSession;
};
