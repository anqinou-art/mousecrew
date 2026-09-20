const express = require('express');

function createProjectsRouter({ store, config, requireToken }) {
  const router = express.Router();
  router.use(requireToken);

  router.get('/api/projects', (req, res) => {
    res.json((config.projects || []).map(({ id }) => {
      const { name, prefix } = store.project.getById.get(id);
      return { id, name, prefix };
    }));
  });

  return router;
}

module.exports = { createProjectsRouter };
