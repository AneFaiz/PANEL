const { db } = require('./db');
const { v4: uuidv4 } = require('uuid');
const log = new (require('cat-loggr'))();
const config = require('../config.json');

async function init() {
    const skyport = await db.get('skyport_instance');
    if (!skyport) {
        log.init('This is probably your first time starting Skyport, welcome!');
        log.init('You can find documentation for the panel at skyport.dev');

        const errorMessages = [];
        let userCheck = await db.get('users');
        
        if (!userCheck) {
            errorMessages.push("If you haven't done it already, make a user for yourself: npm run createUser");
        }

        if (errorMessages.length > 0) {
            errorMessages.forEach(errorMsg => log.error(errorMsg));
            process.exit(); 
        }

        const skyportId = uuidv4();
        const setupTime = Date.now();
        
        const info = {
            skyportId: skyportId,
            setupTime: setupTime,
            originalVersion: config.version
        };

        await db.set('skyport_instance', info);
        log.info('Initialized Skyport panel with ID: ' + skyportId);
    }
    log.info('Init complete!');
}

module.exports = { init };