/**
 * @description Migration: Create chat_history table with composite index.
 */

'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('chat_history', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      session_id: {
        type: Sequelize.STRING(100),
        allowNull: false,
      },
      role: {
        type: Sequelize.STRING(20),
        allowNull: false,
      },
      content: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      source_chunks: {
        type: Sequelize.JSONB,
        defaultValue: null,
      },
      confidence_score: {
        type: Sequelize.FLOAT,
      },
      created_at: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.fn('NOW'),
      },
    });

    await queryInterface.addIndex('chat_history', ['session_id']);
    await queryInterface.addIndex('chat_history', ['session_id', 'created_at']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('chat_history');
  },
};
