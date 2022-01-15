## Setup Development Environment

To develop Homebridge plugins you must have Node.js 12 or later installed, and a modern code editor such as [VS Code](https://code.visualstudio.com/). This plugin uses [TypeScript](https://www.typescriptlang.org/) to make development easier and comes with pre-configured settings for [VS Code](https://code.visualstudio.com/) and ESLint. If you are using VS Code install these extensions:

- [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint)

## Install Development Dependencies

Using a terminal, navigate to the project folder and run this command to install the development dependencies:

```
npm install
```

## Build Plugin

TypeScript needs to be compiled into JavaScript before it can run. The following command will
compile the contents of your [`src`](./src) directory and put the resulting code into the `dist`
folder.

```
npm run build
```

## Link To Homebridge

Run this command so your global install of Homebridge can discover the plugin in your development environment:

```
npm link
```

You can now start Homebridge, use the `-D` flag so you can see debug log messages from the plugin:

```
homebridge -D
```

## Watch For Changes and Build Automatically

If you want to have your code compile automatically as you make changes, and restart Homebridge
automatically between changes you can run:

```
npm run watch
```

This will launch an instance of Homebridge in debug mode which will restart every time you make a
change to the source code. It will load the config stored in the default location under
`~/.homebridge`. You may need to stop other running instances of Homebridge while using this command
to prevent conflicts. You can adjust the Homebridge startup command in the
[`nodemon.json`](./nodemon.json) file.

## Versioning

Given a version number `MAJOR`.`MINOR`.`PATCH`, such as `1.4.3`, increment the:

1. **MAJOR** version when you make breaking changes to the plugin,
2. **MINOR** version when you add functionality in a backwards compatible manner, and
3. **PATCH** version when you make backwards compatible bug fixes.

You can use the `npm version` command to help you with this:

```bash
# major update / breaking changes
npm version major

# minor update / new features
npm version minor

# patch / bugfixes
npm version patch
```

#### Publishing Beta Versions

You can publish _beta_ versions of this plugin for other users to test before you release it to everyone.

```bash
# create a new pre-release version (eg. 2.1.0-beta.1)
npm version prepatch --preid beta

# publsh to @beta
npm publish --tag=beta
```

Users can then install the _beta_ version by appending `@beta` to the install command, for example:

```
sudo npm install -g homebridge-genie-aladdin-connect@beta
```
