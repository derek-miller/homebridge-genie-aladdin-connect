import { Characteristic, CharacteristicValue, PlatformAccessory } from 'homebridge';

import { GenieAladdinConnectHomebridgePlatform } from './platform';
import {
  AladdinDesiredDoorStatus,
  AladdinDoor,
  AladdinDoorStatus,
  AladdinDoorStatusInfo,
} from './aladdinConnect';

export interface GenieAladdinConnectPlatformAccessoryContext {
  door: AladdinDoor;
}

export class GenieAladdinConnectGarageDoorAccessory {
  private readonly log = this.platform.log;
  private readonly hap = this.platform.api.hap;
  private readonly aladdinConnect = this.platform.aladdinConnect;
  private readonly context = <GenieAladdinConnectPlatformAccessoryContext>this.accessory.context;
  private readonly door = this.context.door;
  private readonly id: string = `${this.door.portal}:${this.door.device}:${this.door.id}`;

  private _currentStatus = AladdinDoorStatus.UNKNOWN;
  private _desiredStatus = AladdinDesiredDoorStatus.NONE;
  private _obstructionDetected = false;
  private targetStateCharacteristic: Characteristic;
  private currentStateCharacteristic: Characteristic;
  private obstructionDetectedCharacteristic: Characteristic;

  constructor(
    private readonly platform: GenieAladdinConnectHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Genie')
      .setCharacteristic(this.platform.Characteristic.Model, 'Aladdin Connect')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.id);

    const service = (this.accessory.getService(this.platform.Service.GarageDoorOpener) ||
      this.accessory.addService(
        this.platform.Service.GarageDoorOpener,
        this.door.name,
        this.id,
      ))!.setCharacteristic(this.platform.Characteristic.Name, this.door.name);

    this.targetStateCharacteristic = service
      .getCharacteristic(this.platform.Characteristic.TargetDoorState)
      .onSet(this.setTargetDoorState.bind(this))
      .onGet(this.getTargetDoorState.bind(this));
    this.currentStateCharacteristic = service
      .getCharacteristic(this.platform.Characteristic.CurrentDoorState)
      .onGet(this.getCurrentDoorState.bind(this));
    this.obstructionDetectedCharacteristic = service
      .getCharacteristic(this.platform.Characteristic.ObstructionDetected)
      .onGet(this.getObstructionDetected.bind(this));

    this.aladdinConnect.subscribe(this.door, (info: AladdinDoorStatusInfo) => {
      this.currentStatus = info.status;
      this.obstructionDetected =
        // A fault happens when a door fails to open/close twice in a row and then must be operated
        // manually.
        info.fault ||
        // If the door does not go into its desired state after some timeout it goes into one of
        // these states. The first time it is recoverable.
        [AladdinDoorStatus.TIMEOUT_CLOSING, AladdinDoorStatus.TIMEOUT_OPENING].includes(
          info.status,
        );
      // If the desired status is NONE or an obstruction is detected, derive it from the current
      // status.
      this.desiredStatus =
        info.desiredStatus === AladdinDesiredDoorStatus.NONE || this.obstructionDetected
          ? this.convertStatusToDesiredStatus(this.currentStatus)
          : info.desiredStatus;
    });
  }

  private get currentStatus(): AladdinDoorStatus {
    return this._currentStatus;
  }

  private set currentStatus(value: AladdinDoorStatus) {
    if (this._currentStatus === value) {
      return;
    }
    this.log.debug(
      '[%s] Update Characteristic CurrentDoorState: %s -> %s',
      this.door.name,
      AladdinDoorStatus[this._currentStatus],
      AladdinDoorStatus[value],
    );
    this._currentStatus = value;
    this.currentStateCharacteristic.updateValue(
      this.convertStatusToCurrentStateValue(this._currentStatus),
    );
  }

  private get desiredStatus(): AladdinDesiredDoorStatus {
    return this._desiredStatus;
  }

  private set desiredStatus(value: AladdinDesiredDoorStatus) {
    if (this._desiredStatus === value) {
      return;
    }
    this.log.debug(
      '[%s] Update Characteristic TargetDoorState: %s -> %s',
      this.door.name,
      AladdinDesiredDoorStatus[this._desiredStatus],
      AladdinDesiredDoorStatus[value],
    );
    this._desiredStatus = value;
    this.targetStateCharacteristic.updateValue(
      this.convertDesiredStatusToTargetStateValue(this._desiredStatus),
    );
  }

  private get obstructionDetected(): boolean {
    return this._obstructionDetected;
  }

  private set obstructionDetected(value: boolean) {
    if (this._obstructionDetected === value) {
      return;
    }
    this.log.debug(
      '[%s] Update Characteristic ObstructionDetected: %s -> %s',
      this.door.name,
      this._obstructionDetected ? 'YES' : 'NO',
      value ? 'YES' : 'NO',
    );
    this._obstructionDetected = value;
    this.obstructionDetectedCharacteristic.updateValue(this._obstructionDetected);
  }

  private async setTargetDoorState(value: CharacteristicValue): Promise<void> {
    const desiredStatus = this.convertTargetStateValueToDesiredStatus(value);
    this.log.debug(
      '[%s] Set Characteristic TargetDoorState ->',
      this.door.name,
      AladdinDesiredDoorStatus[desiredStatus],
    );
    await this.aladdinConnect.setDoorStatus(this.door, desiredStatus);
  }

  private async getTargetDoorState(): Promise<CharacteristicValue> {
    this.log.debug(
      '[%s] Get Characteristic TargetDoorState ->',
      this.door.name,
      AladdinDesiredDoorStatus[this.desiredStatus],
    );
    return this.convertDesiredStatusToTargetStateValue(this.desiredStatus);
  }

  private getCurrentDoorState(): CharacteristicValue {
    this.log.debug(
      '[%s] Get Characteristic CurrentDoorState ->',
      this.door.name,
      AladdinDoorStatus[this.currentStatus],
    );
    return this.convertStatusToCurrentStateValue(this.currentStatus);
  }

  private getObstructionDetected(): CharacteristicValue {
    this.log.debug(
      '[%s] Get Characteristic ObstructionDetected ->',
      this.door.name,
      this.obstructionDetected ? 'YES' : 'NO',
    );
    return this.obstructionDetected;
  }

  private convertTargetStateValueToDesiredStatus(
    value: CharacteristicValue,
  ): AladdinDesiredDoorStatus {
    switch (value) {
      case this.platform.Characteristic.TargetDoorState.OPEN:
        return AladdinDesiredDoorStatus.OPEN;
      case this.platform.Characteristic.TargetDoorState.CLOSED:
        return AladdinDesiredDoorStatus.CLOSED;
      default:
        this.log.debug(
          '[%s] Unknown TargetDoorState Characteristic value -> %d',
          this.door.name,
          value,
        );
        throw new this.hap.HapStatusError(this.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
    }
  }

  private convertStatusToCurrentStateValue(status: AladdinDoorStatus): CharacteristicValue {
    switch (status) {
      case AladdinDoorStatus.OPEN:
        return this.platform.Characteristic.CurrentDoorState.OPEN;
      case AladdinDoorStatus.OPENING:
        return this.platform.Characteristic.CurrentDoorState.OPENING;
      case AladdinDoorStatus.CLOSED:
        return this.platform.Characteristic.CurrentDoorState.CLOSED;
      case AladdinDoorStatus.CLOSING:
        return this.platform.Characteristic.CurrentDoorState.CLOSING;
      case AladdinDoorStatus.TIMEOUT_OPENING:
      case AladdinDoorStatus.TIMEOUT_CLOSING:
      case AladdinDoorStatus.UNKNOWN:
      case AladdinDoorStatus.NOT_CONFIGURED:
        return this.platform.Characteristic.CurrentDoorState.STOPPED;
      default:
        this.log.debug('[%s] Unknown Aladdin door status -> %d', this.door.name, status);
        throw new this.hap.HapStatusError(this.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
    }
  }

  private convertDesiredStatusToTargetStateValue(
    status: AladdinDesiredDoorStatus,
  ): CharacteristicValue {
    switch (status) {
      case AladdinDesiredDoorStatus.OPEN:
        return this.platform.Characteristic.TargetDoorState.OPEN;
      case AladdinDesiredDoorStatus.CLOSED:
        return this.platform.Characteristic.TargetDoorState.CLOSED;
      default:
        this.log.debug('[%s] Unknown Aladdin door desired status -> %d', this.door.name, status);
        throw new this.hap.HapStatusError(this.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
    }
  }

  private convertStatusToDesiredStatus(status: AladdinDoorStatus): AladdinDesiredDoorStatus {
    switch (status) {
      case AladdinDoorStatus.OPEN:
      case AladdinDoorStatus.OPENING:
      case AladdinDoorStatus.TIMEOUT_OPENING:
        return AladdinDesiredDoorStatus.OPEN;
      case AladdinDoorStatus.CLOSED:
      case AladdinDoorStatus.CLOSING:
      case AladdinDoorStatus.TIMEOUT_CLOSING:
        return AladdinDesiredDoorStatus.CLOSED;
      case AladdinDoorStatus.UNKNOWN:
      case AladdinDoorStatus.NOT_CONFIGURED:
        return AladdinDesiredDoorStatus.NONE;
      default:
        this.log.debug('[%s] Unknown Aladdin door status -> %d', this.door.name, status);
        throw new this.hap.HapStatusError(this.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
    }
  }
}
