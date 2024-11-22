const express = require('express');
const axios = require('axios');
const { db } = require('../../handlers/db.js');
const { logAudit } = require('../../handlers/auditLog.js');
const log = new (require('cat-loggr'))();
const { loadPlugins } = require('../../plugins/loadPls.js');
const { isUserAuthorizedForContainer, isInstanceSuspended } = require('../../utils/authHelper');
const path = require('path');

const { checkContainerState } = require('../../utils/checkstate.js');

const plugins = loadPlugins(path.join(__dirname, '../../plugins'));
const router = express.Router();

const allPluginData = Object.values(plugins).map(plugin => plugin.config);

/**
 * GET /instance/:id/startup
 * Renders the instance startup page with the available alternative images.
 */
router.get('/instance/:id/startup', async (req, res) => {
    if (!req.user) return res.redirect('/');

    const { id } = req.params;

    if (!id) {
        return res.redirect('/instances');
    }

    try {
        const instance = await db.get(`${id}_instance`);
        if (!instance) {
            return res.redirect('../../instances');
        }

        const isAuthorized = await isUserAuthorizedForContainer(req.user.userId, instance.Id);
        if (!isAuthorized) {
            return res.status(403).send('Unauthorized access to this instance.');
        }

        const suspended = await isInstanceSuspended(req.user.userId, instance, id);
        if (suspended === true) {
            return res.render('instance/suspended', { req, user: req.user });
        }

        // Get egg data if available
        const eggs = await db.get('eggs') || [];
        const eggData = instance.eggData || eggs.find(e => e.Id === instance.imageData?.Id);

        // Format environment variables for display
        const formattedEnv = [];
        if (eggData?.Variables) {
            formattedEnv.push(...eggData.Variables.map(v => ({
                name: v.name,
                value: instance.Env[v.name] || v.defaultValue || '',
                description: v.description || '',
                isEgg: true
            })));
        }
        // Add any additional env vars not from egg
        Object.entries(instance.Env || {}).forEach(([key, value]) => {
            if (!formattedEnv.some(e => e.name === key)) {
                formattedEnv.push({
                    name: key,
                    value: value,
                    description: '',
                    isEgg: false
                });
            }
        });

        res.render('instance/startup.ejs', {
            req,
            user: req.user,
            instance: {
                ...instance,
                formattedEnv,
                StartupCommand: eggData?.StartupCommand || instance.StartupCommand,
                StopCommand: eggData?.StopCommand || instance.StopCommand,
                DockerImages: eggData?.DockerImages || instance.AltImages || {}
            },
            addons: {
                plugins: allPluginData
            }
        });
    } catch (error) {
        log.error('Error fetching instance data:', error);
        res.status(500).json({
            error: 'Failed to load instance data',
            details: error.message
        });
    }
});

/**
 * POST /instances/startup/changevariable/:id
 * Handles the change of a specific environment variable for the instance.
 */
router.post('/instances/startup/changevariable/:id', async (req, res) => {
    if (!req.user) return res.redirect('/');

    const { id } = req.params;
    const { variable, value, user } = req.query;

    if (!id || !variable || !user) {
        return res.status(400).json({ error: 'Missing parameters' });
    }

    try {
        const instance = await db.get(`${id}_instance`);
        if (!instance) {
            return res.status(404).json({ error: 'Instance not found' });
        }

        const isAuthorized = await isUserAuthorizedForContainer(req.user.userId, instance.Id);
        if (!isAuthorized) {
            return res.status(403).send('Unauthorized access to this instance.');
        }

        const suspended = await isInstanceSuspended(req.user.userId, instance, id);
        if (suspended === true) {
            return res.render('instance/suspended', { req, user: req.user });
        }

        // Get egg data if available
        const eggs = await db.get('eggs') || [];
        const eggData = instance.eggData || eggs.find(e => e.Id === instance.imageData?.Id);

        // Update environment variable
        const updatedEnv = { ...instance.Env };
        updatedEnv[variable] = value;

        // Validate against egg configuration if available
        if (eggData?.Variables) {
            const varConfig = eggData.Variables.find(v => v.name === variable);
            if (varConfig?.validation) {
                const regex = new RegExp(varConfig.validation);
                if (!regex.test(value)) {
                    return res.status(400).json({
                        error: 'Invalid value',
                        details: `Value does not match required format: ${varConfig.validation}`
                    });
                }
            }
        }

        const updatedInstance = { ...instance, Env: updatedEnv };
        await db.set(`${id}_instance`, updatedInstance);

        logAudit(req.user.userId, req.user.username, 'instance:variableChange', req.ip);
        res.json({ success: true });
    } catch (error) {
        log.error('Error updating environment variable:', error);
        res.status(500).json({
            error: 'Failed to update environment variable',
            details: error.message
        });
    }
});

/**
 * GET /instances/startup/changeimage/:id
 * Handles the change of the instance image based on the parameters provided via query strings.
 */
router.get('/instances/startup/changeimage/:id', async (req, res) => {
    if (!req.user) return res.redirect('/');

    const { id } = req.params;

    if (!id) {
        return res.redirect('/instances');
    }

    try {
        const instance = await db.get(`${id}_instance`);
        if (!instance) {
            return res.redirect('/instances');
        }

        const isAuthorized = await isUserAuthorizedForContainer(req.user.userId, instance.Id);
        if (!isAuthorized) {
            return res.status(403).send('Unauthorized access to this instance.');
        }

        const suspended = await isInstanceSuspended(req.user.userId, instance, id);
        if (suspended === true) {
            return res.render('instance/suspended', { req, user: req.user });
        }

        const nodeId = instance.Node.id;
        const { image, user } = req.query;

        if (!image || !user || !nodeId) {
            return res.status(400).json({ error: 'Missing parameters' });
        }

        const node = await db.get(`${nodeId}_node`);
        if (!node) {
            return res.status(400).json({ error: 'Invalid node' });
        }

        const requestData = await prepareRequestData(image, instance.Memory, instance.Cpu, instance.Ports, instance.Name, node, id, instance.ContainerId, instance.Env);
        const response = await axios(requestData);

        await updateDatabaseWithNewInstance(response.data, user, node, image, instance.Memory, instance.Cpu, instance.Ports, instance.Primary, instance.Name, id, image, instance.imageData, instance.Env);

        checkContainerState(id, node.address, node.port, node.apiKey, user);
        logAudit(req.user.userId, req.user.username, 'instance:imageChange', req.ip);
        res.status(201).redirect(`/instance/${id}/startup`);
    } catch (error) {
        log.error('Error changing instance image:', error);
        res.status(500).json({
            error: 'Failed to change container image',
            details: error.response ? error.response.data : 'No additional error info'
        });
    }
});

async function prepareRequestData(image, memory, cpu, ports, name, node, id, containerId, Env) {
    const rawImages = await db.get('images');
    const eggs = await db.get('eggs') || [];
    const imageData = rawImages.find(i => i.Image === image);
    const eggData = eggs.find(e => e.Id === imageData?.Id);

    // Get Docker image configuration
    let dockerImage = image;
    if (eggData?.DockerImages) {
        // If egg has docker_images field, try to get the specified version or fall back to latest
        const version = Env?.version || 'latest';
        dockerImage = eggData.DockerImages[version] || eggData.DockerImages['latest'] || image;
    }

    const requestData = {
        method: 'post',
        url: `http://${node.address}:${node.port}/instances/redeploy/${containerId}/${id}`,
        auth: {
            username: 'Skyport',
            password: node.apiKey
        },
        headers: {
            'Content-Type': 'application/json'
        },
        data: {
            Name: name,
            Id: id,
            Image: dockerImage,
            Env: eggData?.Variables?.reduce((acc, v) => {
                acc[v.name] = v.defaultValue;
                return acc;
            }, {}) || Env || {},
            Scripts: eggData?.Scripts || imageData?.Scripts || {},
            Memory: memory ? parseInt(memory) : undefined,
            Cpu: cpu ? parseInt(cpu) : undefined,
            ExposedPorts: {},
            PortBindings: {},
            AltImages: eggData?.DockerImages || imageData?.AltImages || {},
            StartupCommand: eggData?.StartupCommand,
            StopCommand: eggData?.StopCommand,
            eggData
        }
    };

    if (ports) {
        ports.split(',').forEach(portMapping => {
            const [containerPort, hostPort] = portMapping.split(':');
            const key = `${containerPort}/tcp`;
            requestData.data.ExposedPorts[key] = {};
            requestData.data.PortBindings[key] = [{ HostPort: hostPort }];
        });
    }
    return requestData;
}

async function updateDatabaseWithNewInstance(responseData, userId, node, image, memory, cpu, ports, primary, name, id, currentimage, imagedata, Env) {
    const rawImages = await db.get('images');
    const eggs = await db.get('eggs') || [];
    const imageData = rawImages.find(i => i.Image === image);
    const eggData = eggs.find(e => e.Id === imageData?.Id);

    const instanceData = {
        Name: name,
        Id: id,
        Node: node,
        User: userId,
        ContainerId: responseData.containerId,
        VolumeId: id,
        Memory: parseInt(memory),
        Cpu: parseInt(cpu),
        Ports: ports,
        Primary: primary,
        Env: responseData.Env,
        Image: image,
        CurrentImage: currentimage,
        AltImages: eggData?.DockerImages || imageData?.AltImages || {},
        StartupCommand: eggData?.StartupCommand,
        StopCommand: eggData?.StopCommand,
        Scripts: eggData?.Scripts || imageData?.Scripts || {},
        eggData,
        imageData: imagedata,
        InternalState: 'READY'
    };

    let userInstances = await db.get(`${userId}_instances`) || [];
    userInstances = userInstances.filter(instance => instance.Id !== id);
    userInstances.push(instanceData);
    await db.set(`${userId}_instances`, userInstances);

    let globalInstances = await db.get('instances') || [];
    globalInstances = globalInstances.filter(instance => instance.Id !== id);
    globalInstances.push(instanceData);
    await db.set('instances', globalInstances);

    await db.set(`${id}_instance`, instanceData);
}

module.exports = router;