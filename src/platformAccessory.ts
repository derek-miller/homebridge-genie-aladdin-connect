import {Characteristic, CharacteristicValue, Logger, PlatformAccessory, Service} from 'homebridge';

import {GenieAladdinConnectHomebridgePlatform} from './platform';
import {AladdinConnect, AladdinDesiredDoorStatus, AladdinDoor, AladdinDoorStatus} from './aladdinConnect';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class GenieAladdinConnectGarageDoorAccessory {
  private readonly Service: typeof Service = this.platform.Service;
  private readonly Characteristic: typeof Characteristic = this.platform.Characteristic;
  private readonly log: Logger = this.platform.log;
  private readonly aladdinConnect: AladdinConnect = this.platform.aladdinConnect;

  private readonly door: AladdinDoor = this.accessory.context.door;
  private readonly id: string = `${this.door.portal}:${this.door.device}:${this.door.id}`;

  private pendingChange = false;
  private currentStatus: AladdinDoorStatus = AladdinDoorStatus.UNKNOWN;
  private targetStatus: AladdinDesiredDoorStatus | null = null;
  private expectedStatus: AladdinDoorStatus | null = null;

  constructor(
    private readonly platform: GenieAladdinConnectHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.accessory.getService(this.Service.AccessoryInformation)!
      .setCharacteristic(this.Characteristic.Manufacturer, 'Genie')
      .setCharacteristic(this.Characteristic.Model, 'Aladdin Connect')
      .setCharacteristic(this.Characteristic.SerialNumber, this.id);

    // get the GarageDoorOpener service if it exists, otherwise create a new GarageDoorOpener service
    // you can create multiple services for each accessory
    const service = (
      this.accessory.getService(this.door.name) ||
      this.accessory.addService(this.Service.GarageDoorOpener, this.door.name, this.id)
    );

    service.setCharacteristic(this.Characteristic.Name, this.door.name);

    // each service must implement at-minimum the "required characteristics" for the given service type
    // see https://developers.homebridge.io/#/service/GarageDoorOpener

    // register handlers for the Target State Characteristic
    service.getCharacteristic(this.Characteristic.TargetDoorState)
      .onSet(this.setTargetDoorState.bind(this))
      .onGet(this.getTargetDoorState.bind(this));

    // register handlers for the Current State Characteristic
    service.getCharacteristic(this.Characteristic.CurrentDoorState)
      .onGet(this.getCurrentDoorState.bind(this));

    // register handlers for the Obstruction Detected Characteristic
    service.getCharacteristic(this.Characteristic.ObstructionDetected)
      .onGet(this.handleObstructionDetectedGet.bind(this));

    /**
     * Updating characteristics values asynchronously.
     *
     * Here we poll the state from the aladdin connect service and use the result to update the current state
     * characteristic.
     *
     */
    setInterval(() => {
      // Skip any updates while we are in progress of making a change.
      if (this.pendingChange) {
        this.log.debug('[%s] Skipping poll cycle due to a pending change', this.door.name);
        return;
      }
      this.log.debug('[%s] Polling current door state', this.door.name);
      this.aladdinConnect.getDoorStatus(this.door).then((info) => {
        if (!info) {
          return;
        }
        this.currentStatus = info.status;

        // Reset the targetStatus when currentStatus reflects the change.
        if (
          (
            this.targetStatus === AladdinDesiredDoorStatus.CLOSED &&
            [
              AladdinDoorStatus.CLOSING,
              AladdinDoorStatus.CLOSED,
              AladdinDoorStatus.TIMEOUT_CLOSING,
            ].includes(this.currentStatus)
          ) || (
            this.targetStatus === AladdinDesiredDoorStatus.OPENED &&
            [
              AladdinDoorStatus.OPENING,
              AladdinDoorStatus.OPEN,
              AladdinDoorStatus.TIMEOUT_OPENING,
            ].includes(this.currentStatus)
          )
        ) {
          this.targetStatus = null;
        }
        // Reset the expectedStatus when currentStatus reflects the change.
        if (
          (
            this.expectedStatus === AladdinDoorStatus.CLOSING &&
            [
              AladdinDoorStatus.CLOSING,
              AladdinDoorStatus.CLOSED,
              AladdinDoorStatus.TIMEOUT_CLOSING,
            ].includes(this.currentStatus)
          ) || (
            this.expectedStatus === AladdinDoorStatus.OPENING &&
            [
              AladdinDoorStatus.OPENING,
              AladdinDoorStatus.OPEN,
              AladdinDoorStatus.TIMEOUT_OPENING,
            ].includes(this.currentStatus)
          )
        ) {
          this.expectedStatus = null;
        }

        service.updateCharacteristic(
          this.Characteristic.TargetDoorState,
          this.getTargetDoorState(),
        );
        service.updateCharacteristic(
          this.Characteristic.CurrentDoorState,
          this.getCurrentDoorState(),
        );
      });
    }, 2000);
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, opening the garage door.
   */
  async setTargetDoorState(value: CharacteristicValue) {
    if (this.getTargetDoorState() === value) {
      this.log.debug('[%s] Ignoring target state set since it is unchanged', this.door.name);
      return;
    }
    this.pendingChange = true;
    try {
      switch (value) {
        case this.Characteristic.TargetDoorState.OPEN:
          this.log.debug('[%s] Setting target state -> OPEN', this.door.name);
          await this.aladdinConnect.setDoorStatus(this.door, AladdinDesiredDoorStatus.OPENED);
          this.targetStatus = AladdinDesiredDoorStatus.OPENED;
          this.expectedStatus = AladdinDoorStatus.OPENING;
          break;
        case this.Characteristic.TargetDoorState.CLOSED:
          this.log.debug('[%s] Setting target state -> CLOSED', this.door.name);
          await this.aladdinConnect.setDoorStatus(this.door, AladdinDesiredDoorStatus.CLOSED);
          this.targetStatus = AladdinDesiredDoorStatus.CLOSED;
          this.expectedStatus = AladdinDoorStatus.CLOSING;
          break;
      }
    } finally {
      this.pendingChange = false;
    }
  }

  /**
   * Handle the "GET" requests from HomeKit
   * These are sent when HomeKit wants to know the current state of the accessory, for example, checking if a Light bulb
   * is on.
   *
   * GET requests should return as fast as possible. A long delay here will result in
   * HomeKit being unresponsive and a bad user experience in general.
   *
   * If your device takes time to respond you should update the status of your device
   * asynchronously instead using the `updateCharacteristic` method instead.

   * @example
   * this.service.updateCharacteristic(this.platform.Characteristic.On, true)
   */
  getTargetDoorState(): CharacteristicValue {
    // Use the targeted status if defined, otherwise fall back to using the current status
    switch (this.targetStatus) {
      case AladdinDesiredDoorStatus.OPENED:
        this.log.debug('[%s] Target state -> OPEN', this.door.name);
        return this.Characteristic.TargetDoorState.OPEN;
      case AladdinDesiredDoorStatus.CLOSED:
        this.log.debug('Target state -> CLOSED');
        return this.Characteristic.TargetDoorState.CLOSED;
    }
    switch (this.expectedStatus ?? this.currentStatus) {
      case AladdinDoorStatus.OPEN:
      case AladdinDoorStatus.OPENING:
      case AladdinDoorStatus.TIMEOUT_OPENING:
        this.log.debug('[%s] Target state -> OPEN', this.door.name);
        return this.Characteristic.TargetDoorState.OPEN;
      case AladdinDoorStatus.CLOSED:
      case AladdinDoorStatus.CLOSING:
      case AladdinDoorStatus.TIMEOUT_CLOSING:
      case AladdinDoorStatus.UNKNOWN:
      case AladdinDoorStatus.NOT_CONFIGURED:
      default:
        this.log.debug('Target state -> CLOSED');
        return this.Characteristic.TargetDoorState.CLOSED;
    }
  }

  /**
   * Handle requests to get the current value of the "Obstruction Detected" characteristic
   */
  getCurrentDoorState(): CharacteristicValue {
    switch (this.expectedStatus ?? this.currentStatus) {
      case AladdinDoorStatus.OPEN:
        this.log.debug('[%s] Current state -> OPEN', this.door.name);
        return this.Characteristic.CurrentDoorState.OPEN;
      case AladdinDoorStatus.OPENING:
        this.log.debug('[%s] Current state -> OPENING', this.door.name);
        return this.Characteristic.CurrentDoorState.OPENING;
      case AladdinDoorStatus.CLOSED:
        this.log.debug('[%s] Current state -> CLOSED', this.door.name);
        return this.Characteristic.CurrentDoorState.CLOSED;
      case AladdinDoorStatus.CLOSING:
        this.log.debug('[%s] Current state -> CLOSING', this.door.name);
        return this.Characteristic.CurrentDoorState.CLOSING;
      case AladdinDoorStatus.TIMEOUT_OPENING:
      case AladdinDoorStatus.TIMEOUT_CLOSING:
      case AladdinDoorStatus.UNKNOWN:
      case AladdinDoorStatus.NOT_CONFIGURED:
      default:
        this.log.debug('[%s] Current state -> STOPPED', this.door.name);
        return this.Characteristic.CurrentDoorState.STOPPED;
    }
  }

  /**
   * Handle requests to get the current value of the "Obstruction Detected" characteristic
   */
  handleObstructionDetectedGet(): CharacteristicValue {
    // TODO
    return false;
  }
}
