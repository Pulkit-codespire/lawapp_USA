/**
 * @module models/UsageLog
 * @description Tracks AI API usage — tokens, costs, model, and operation type.
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const UsageLog = sequelize.define('UsageLog', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    operation: {
      type: DataTypes.STRING(30),
      allowNull: false,
      comment: 'chat | embedding | re-embed',
    },
    provider: {
      type: DataTypes.STRING(20),
      allowNull: false,
      comment: 'openai | gemini',
    },
    model: {
      type: DataTypes.STRING(60),
      allowNull: false,
    },
    inputTokens: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      field: 'input_tokens',
    },
    outputTokens: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      field: 'output_tokens',
    },
    totalTokens: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      field: 'total_tokens',
    },
    cost: {
      type: DataTypes.FLOAT,
      defaultValue: 0,
      comment: 'Estimated cost in USD',
    },
    metadata: {
      type: DataTypes.JSONB,
      defaultValue: {},
      comment: 'Extra info — chunk count, batch size, etc.',
    },
  }, {
    tableName: 'usage_logs',
    underscored: true,
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
  });

  return UsageLog;
};
