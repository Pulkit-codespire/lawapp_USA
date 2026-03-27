/**
 * @module models/Chunk
 * @description Chunk model — stores text chunks with pgvector embeddings.
 */

const { DataTypes } = require('sequelize');

/**
 * Define the Chunk model.
 * @param {import('sequelize').Sequelize} sequelize - Sequelize instance
 * @returns {import('sequelize').Model} Chunk model
 */
module.exports = (sequelize) => {
  const Chunk = sequelize.define('Chunk', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    documentId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: 'document_id',
      references: { model: 'documents', key: 'id' },
    },
    chunkText: {
      type: DataTypes.TEXT,
      allowNull: false,
      field: 'chunk_text',
    },
    chunkIndex: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      field: 'chunk_index',
    },
    tokenCount: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      field: 'token_count',
    },
    section: {
      type: DataTypes.STRING(200),
      defaultValue: 'general',
    },
    pageNumber: {
      type: DataTypes.INTEGER,
      field: 'page_number',
    },
    embedding: {
      type: DataTypes.ARRAY(DataTypes.FLOAT),
      defaultValue: null,
    },
    metadataJson: {
      type: DataTypes.JSONB,
      defaultValue: {},
      field: 'metadata_json',
    },
  }, {
    tableName: 'chunks',
    underscored: true,
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
    indexes: [
      { fields: ['document_id'] },
      { fields: ['section'] },
    ],
  });

  /**
   * Set up model associations.
   * @param {Object} models - All registered models
   */
  Chunk.associate = (models) => {
    Chunk.belongsTo(models.Document, {
      foreignKey: 'document_id',
      as: 'document',
    });
  };

  return Chunk;
};
