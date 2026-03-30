/**
 * @module models/Settings
 * @description Settings model — stores user AI configuration preferences.
 */

const { DataTypes } = require('sequelize');

/**
 * Define the Settings model.
 * @param {import('sequelize').Sequelize} sequelize - Sequelize instance
 * @returns {import('sequelize').Model} Settings model
 */
module.exports = (sequelize) => {
  const Settings = sequelize.define('Settings', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    key: {
      type: DataTypes.STRING(100),
      allowNull: false,
      unique: true,
    },
    value: {
      type: DataTypes.JSONB,
      allowNull: false,
    },
  }, {
    tableName: 'settings',
    underscored: true,
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  /**
   * Get a setting by key, return defaultValue if not found.
   * @param {string} key
   * @param {*} defaultValue
   * @returns {Promise<*>}
   */
  Settings.get = async function (key, defaultValue = null) {
    const row = await this.findOne({ where: { key } });
    return row ? row.value : defaultValue;
  };

  /**
   * Set a setting by key (upsert).
   * @param {string} key
   * @param {*} value
   * @returns {Promise<Model>}
   */
  Settings.set = async function (key, value) {
    const [row] = await this.upsert({ key, value }, { returning: true });
    return row;
  };

  return Settings;
};
