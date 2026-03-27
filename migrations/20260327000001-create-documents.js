/**
 * @description Migration: Enable pgvector extension and create documents table.
 */

'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    /* Enable pgvector extension */
    await queryInterface.sequelize.query('CREATE EXTENSION IF NOT EXISTS vector');

    await queryInterface.createTable('documents', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      case_name: {
        type: Sequelize.STRING(500),
        allowNull: false,
      },
      case_folder: {
        type: Sequelize.STRING(1000),
      },
      file_name: {
        type: Sequelize.STRING(500),
        allowNull: false,
      },
      file_path: {
        type: Sequelize.STRING(2000),
        unique: true,
      },
      file_type: {
        type: Sequelize.STRING(50),
      },
      document_type: {
        type: Sequelize.STRING(100),
      },
      total_pages: {
        type: Sequelize.INTEGER,
        defaultValue: 0,
      },
      total_chunks: {
        type: Sequelize.INTEGER,
        defaultValue: 0,
      },
      extraction_method: {
        type: Sequelize.STRING(50),
      },
      is_processed: {
        type: Sequelize.BOOLEAN,
        defaultValue: false,
      },
      processing_error: {
        type: Sequelize.TEXT,
      },
      ingested_at: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.fn('NOW'),
      },
      updated_at: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.fn('NOW'),
      },
    });

    await queryInterface.addIndex('documents', ['case_name']);
    await queryInterface.addIndex('documents', ['file_type']);
    await queryInterface.addIndex('documents', ['is_processed']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('documents');
  },
};
