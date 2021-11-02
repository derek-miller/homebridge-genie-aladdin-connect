import {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import {PLATFORM_NAME, PLUGIN_NAME} from './settings';
import {GenieAladdinConnectGarageDoorAccessory} from './platformAccessory';
import {AladdinConnect} from './aladdinConnect';

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class GenieAladdinConnectHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];
  public readonly aladdinConnect: AladdinConnect;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.aladdinConnect = new AladdinConnect(log, config.username, config.password);
    this.log.debug('Finished initializing platform:', this.config.name);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', async () => {
      log.debug('Executed didFinishLaunching callback');
      // run the method to discover / register your devices as accessories
      await this.discoverDevices();
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  /**
   * This is an example method showing how to register discovered accessories.
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  async discoverDevices() {
    const doors = await this.aladdinConnect.getAllDoors();
    const discoveredUUIDs: Set<string> = new Set();

    // loop over the discovered devices and register each one if it has not already been registered
    for (const door of doors) {

      // generate a unique id for the accessory this should be generated from
      // something globally unique, but constant, for example, the device serial
      // number or MAC address
      const uuid = this.api.hap.uuid.generate(`${door.portal}:${door.device}:${door.id}:${door.name}`);
      discoveredUUIDs.add(uuid);

      // see if an accessory with the same uuid has already been registered and restored from
      // the cached devices we stored in the `configureAccessory` method above
      const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

      if (existingAccessory) {
        // the accessory already exists
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);

        // Update the context
        existingAccessory.context.door = door;
        this.api.updatePlatformAccessories([existingAccessory]);

        new GenieAladdinConnectGarageDoorAccessory(this, existingAccessory);
      } else {
        this.log.info('Adding new accessory:', door.name);

        // create a new accessory
        const accessory = new this.api.platformAccessory(door.name, uuid);

        // store a copy of the device object in the `accessory.context`
        // the `context` property can be used to store any data about the accessory you may need
        accessory.context.door = door;

        // create the accessory handler for the newly create accessory
        // this is imported from `platformAccessory.ts`
        new GenieAladdinConnectGarageDoorAccessory(this, accessory);

        // link the accessory to your platform
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
    const unknownAccessories = this.accessories.filter(accessory => !discoveredUUIDs.has(accessory.UUID));
    if (unknownAccessories.length > 0) {
      this.log.info('Removing existing accessories from cache: ', unknownAccessories.map(({displayName}) => displayName).join(', '));
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, unknownAccessories);
    }
  }
}
