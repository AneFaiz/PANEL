const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../../handlers/db.js');
const { logAudit } = require('../../handlers/auditLog.js');
const { isAdmin } = require('../../utils/isAdmin.js');
const log = new (require('cat-loggr'))();

router.get('/admin/images', isAdmin, async (req, res) => {
  try {
    const images = await db.get('images') || [];
    const eggs = await db.get('eggs') || [];
    const nodes = await db.get('nodes') || [];
    
    res.render('admin/images', {
      req,
      user: req.user,
      images,
      eggs,
      nodes
    });
  } catch (err) {
    log.error('Error in /admin/images route:', err);
    res.status(500).render('error', {
      req,
      user: req.user,
      error: 'Error fetching images: ' + err.message
    });
  }
});

router.post('/admin/images/upload', isAdmin, async (req, res) => {
  try {
    const eggData = req.body;
    
    // Generate unique ID for the egg
    eggData.Id = uuidv4();
    
    // Process Docker images
    if (!eggData.DockerImages) {
      eggData.DockerImages = {};
      
      // First try to get images from docker_images field
      if (eggData.docker_images && typeof eggData.docker_images === 'object') {
        // Convert directly from egg format
        eggData.DockerImages = { ...eggData.docker_images };
      }
      // If no docker_images, try single docker_image
      else if (eggData.docker_image) {
        eggData.DockerImages['latest'] = eggData.docker_image;
      }
      // If still no images, set default Node.js image
      else {
        eggData.DockerImages['latest'] = 'node:latest';
      }
    }
    
    // Process environment variables
    if (!eggData.Variables && eggData.environment) {
      eggData.Variables = eggData.environment.map(env => ({
        name: env.env_variable,
        displayName: env.name || env.env_variable,
        description: env.description || '',
        defaultValue: env.default_value || '',
        userViewable: env.user_viewable || true,
        userEditable: env.user_editable || false,
        rules: env.rules || ''
      }));
    }
    
    // Store the egg
    let eggs = await db.get('eggs') || [];
    eggs.push(eggData);
    await db.set('eggs', eggs);
    
    // Add to images list for backward compatibility
    let images = await db.get('images') || [];
    images.push({
      Id: eggData.Id,
      Name: eggData.name || eggData.Name,
      Author: eggData.author || 'Unknown',
      AuthorName: eggData.author_name || eggData.AuthorName || 'Unknown',
      DockerImage: Object.values(eggData.DockerImages)[0] || '',
      Description: eggData.description || ''
    });
    await db.set('images', images);
    
    logAudit(req.user.userId, req.user.username, 'egg:upload', req.ip);
    res.status(200).json({ message: 'Egg uploaded successfully', egg: eggData });
  } catch (err) {
    log.error('Error uploading egg:', err);
    res.status(500).json({ error: 'Error uploading egg: ' + err.message });
  }
});

router.post('/admin/images/delete', isAdmin, async (req, res) => {
  try {
    const { id } = req.body;
    
    // Remove from eggs
    let eggs = await db.get('eggs') || [];
    eggs = eggs.filter(egg => egg.Id !== id);
    await db.set('eggs', eggs);
    
    // Remove from images for backward compatibility
    let images = await db.get('images') || [];
    images = images.filter(image => image.Id !== id);
    await db.set('images', images);
    
    logAudit(req.user.userId, req.user.username, 'egg:delete', req.ip);
    res.status(200).json({ message: 'Egg deleted successfully' });
  } catch (err) {
    log.error('Error deleting egg:', err);
    res.status(500).json({ error: 'Error deleting egg: ' + err.message });
  }
});

module.exports = router;