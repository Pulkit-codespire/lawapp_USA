/**
 * @module models/Document
 * @description Document model — stores metadata for each ingested file.
 */

const { DataTypes } = require('sequelize');

/**
 * Define the Document model.
 * @param {import('sequelize').Sequelize} sequelize - Sequelize instance
 * @returns {import('sequelize').Model} Document model
 */
module.exports = (sequelize) => {
  const Document = sequelize.define('Document', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    caseName: {
      type: DataTypes.STRING(500),
      allowNull: false,
      field: 'case_name',
    },
    caseFolder: {
      type: DataTypes.STRING(1000),
      field: 'case_folder',
    },
    fileName: {
      type: DataTypes.STRING(500),
      allowNull: false,
      field: 'file_name',
    },
    filePath: {
      type: DataTypes.STRING(2000),
      unique: true,
      field: 'file_path',
    },
    fileType: {
      type: DataTypes.STRING(50),
      field: 'file_type',
    },
    documentType: {
      type: DataTypes.STRING(100),
      field: 'document_type',
    },
    totalPages: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      field: 'total_pages',
    },
    totalChunks: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      field: 'total_chunks',
    },
    extractionMethod: {
      type: DataTypes.STRING(50),
      field: 'extraction_method',
    },
    isProcessed: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      field: 'is_processed',
    },
    processingError: {
      type: DataTypes.TEXT,
      field: 'processing_error',
    },
  }, {
    tableName: 'documents',
    underscored: true,
    timestamps: true,
    createdAt: 'ingested_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['case_name'] },
      { fields: ['file_type'] },
      { fields: ['is_processed'] },
    ],
  });

  /**
   * Set up model associations.
   * @param {Object} models - All registered models
   */
  Document.associate = (models) => {
    Document.hasMany(models.Chunk, {
      foreignKey: 'document_id',
      as: 'chunks',
      onDelete: 'CASCADE',
    });
  };

  return Document;
};
