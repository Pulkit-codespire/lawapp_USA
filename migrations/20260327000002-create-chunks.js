/**
 * @description Migration: Create chunks table with pgvector embedding column and HNSW index.
 */

'use strict';

const EMBEDDING_DIMENSIONS = 1536;

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('chunks', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      document_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'documents', key: 'id' },
        onDelete: 'CASCADE',
      },
      chunk_text: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      chunk_index: {
        type: Sequelize.INTEGER,
        defaultValue: 0,
      },
      token_count: {
        type: Sequelize.INTEGER,
        defaultValue: 0,
      },
      section: {
        type: Sequelize.STRING(200),
        defaultValue: 'general',
      },
      page_number: {
        type: Sequelize.INTEGER,
      },
      metadata_json: {
        type: Sequelize.JSONB,
        defaultValue: {},
      },
      created_at: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.fn('NOW'),
      },
    });

    /* Add pgvector embedding column (not natively supported by queryInterface) */
    await queryInterface.sequelize.query(
      `ALTER TABLE chunks ADD COLUMN embedding vector(${EMBEDDING_DIMENSIONS})`,
    );

    /* Create HNSW index for fast cosine similarity search */
    await queryInterface.sequelize.query(
      'CREATE INDEX idx_chunks_embedding ON chunks USING hnsw (embedding vector_cosine_ops)',
    );

    await queryInterface.addIndex('chunks', ['document_id']);
    await queryInterface.addIndex('chunks', ['section']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('chunks');
  },
};
