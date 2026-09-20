const express = require('express');

function createProjectsRouter({ config, requireToken }) {
  const router = express.Router();
  router.use(requireToken);

  router.get('/api/projects', (req, res) => {
    res.json((config.projects || []).map(({ id, name, prefix }) => ({ id, name, prefix })));
  });

  return router;
}

module.exports = { createProjectsRouter };
