import {
  API,
  APIEvent,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import {
  GenieAladdinConnectGarageDoorAccessory,
  GenieAladdinConnectPlatformAccessoryContext,
} from './platformAccessory';
import { AladdinConnect, AladdinConnectConfig, AladdinDoor } from './aladdinConnect';

export class GenieAladdinConnectHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: PlatformAccessory[] = [];
  public readonly aladdinConnect: AladdinConnect;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;
    this.aladdinConnect = new AladdinConnect(log, <AladdinConnectConfig>(<unknown>config));
    this.api.on(APIEvent.DID_FINISH_LAUNCHING, async () => this.discoverDevices());
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  async discoverDevices() {
    let doors: AladdinDoor[];
    try {
      doors = await this.aladdinConnect.getAllDoors();
    } catch (error: unknown) {
      this.log.error('Failed to load doors from account; retrying in 5 minutes');
      setTimeout(this.discoverDevices.bind(this), 5 * 60 * 1000);
      return;
    }
    const discoveredUUIDs: Set<string> = new Set();

    for (const door of doors) {
      if (door.ownership === 'owned' || this.config.showShared === true) {
        const uuid = this.api.hap.uuid.generate(`${door.deviceId}:${door.index}`);
        discoveredUUIDs.add(uuid);

        let accessory = this.accessories.find((accessory) => accessory.UUID === uuid);
        const existingAccessory = !!accessory;
        accessory = accessory ?? new this.api.platformAccessory(door.name, uuid);

        // Update the accessory context with the door.
        accessory.context = <GenieAladdinConnectPlatformAccessoryContext>{
          door,
        };

        if (existingAccessory) {
          this.log.info('Restoring existing accessory from cache:', accessory.displayName);
          this.api.updatePlatformAccessories([accessory]);
        } else {
          this.log.info('Adding new accessory:', door.name);
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
        new GenieAladdinConnectGarageDoorAccessory(this, accessory);
      } else {
        this.log.info('Not adding door:', door.name, ' because it is not owned by this account.');
      }
    }

    const orphanedAccessories = this.accessories.filter(
      (accessory) => !discoveredUUIDs.has(accessory.UUID),
    );
    if (orphanedAccessories.length > 0) {
      this.log.debug(
        'Removing orphaned accessories from cache: ',
        orphanedAccessories.map(({ displayName }) => displayName).join(', '),
      );
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, orphanedAccessories);
    }
  }
}
