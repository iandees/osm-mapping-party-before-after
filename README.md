# Mapping party before–after

Make an image (or animated GIF) of OSM data of an area from 2 dates, showing what was changed.

> This repo is a fork of [`amandasaurus/osm-mapping-party-before-after`](https://github.com/amandasaurus/osm-mapping-party-before-after) that adds a web frontend, available at <https://beforeafter.mapki.com>. Make sure you clone **this** repo (<https://github.com/iandees/osm-mapping-party-before-after>) when following the instructions below, since they don't apply to the upstream one.

There are three ways to use it:

1. **Hosted web app** – draw a box, pick two dates, get a GIF by email: <https://beforeafter.mapki.com>. See [WEBAPP.md](./WEBAPP.md) for how it is built and deployed.
2. **Docker** (recommended for running it yourself) – see [below](#running-with-docker).
3. **Local installation** – install the dependencies yourself and run `make.sh`.

## Making a local Installation

1. *On macOS:* [install Homebrew](https://brew.sh/#:~:text=Install%20Homebrew)
1. [Install `pipx`](https://pipx.pypa.io/stable/installation/#installing-pipx)
1. [Install `openstreetmap-carto`](https://github.com/gravitystorm/openstreetmap-carto/blob/4ec2dc9391c411e124c78b3ba1aad9173fea20cb/INSTALL.md)
1. Install [`osmium-tool`](https://github.com/osmcode/osmium-tool)
1. [Install Mapnik](https://github.com/mapnik/mapnik/blob/master/INSTALL.md#source-build)
1. [Install `python-mapnik`](https://github.com/mapnik/python-mapnik#building-from-source)
1. Install [`nik4`](https://github.com/Zverik/Nik4) (used to generate an image with the [`openstreetmap-carto` map style](https://github.com/gravitystorm/openstreetmap-carto/)):
   ```bash
   pipx install nik4
   ```
1. [Install GraphicsMagick](http://www.graphicsmagick.org/README.html#id4)
1. *On macOS:* replace built-in `coreutils` commands with the GNU ones:
   ```bash
   brew install coreutils
   export PATH="$HOMEBREW_PREFIX/opt/coreutils/libexec/gnubin:$PATH
   ```
1. Clone this repo:
   ```bash
   git clone --recurse-submodules https://github.com/iandees/osm-mapping-party-before-after
   cd osm-mapping-party-before-after
   ```

## Running with Docker

The pipeline and all of its dependencies are packaged in the `Dockerfile` in this repo. A prebuilt `amd64` image is available from the GitHub Container Registry as [`ghcr.io/iandees/osm-mapping-party-before-after:main`](https://github.com/iandees/osm-mapping-party-before-after/pkgs/container/osm-mapping-party-before-after), or you can build it yourself from this repo as described below. The base image is `amd64`-only, so on Apple Silicon add `--platform linux/amd64` to the `docker pull`/`docker build` commands.

### Building the Docker container from scratch

Start by cloning this repository:

```bash
git clone --recurse-submodules https://github.com/iandees/osm-mapping-party-before-after
cd osm-mapping-party-before-after
git submodule init
git submodule update
```
Then we build the image that is specified in the `Dockerfile`, picking a name for the image, e.g. `before_after_builder`.
Depending on how you installed Docker, you might have to run `sudo` for each `docker` command.

 ```bash
docker build -t before_after_builder .
```

This step needs to be run only once, and it can take a few minutes as it will download and build all the dependencies needed. 

#### Running the container locally

Once the step is finished, you can launch the container like so:

```bash
./docker_run.sh before_after_builder /full/path/to/in-out-dir/ 
```

The command takes two parameters:

1. the name of the container (e.g. as specified during the `docker build` step)
2. a full path to a directory you want to use for accessing and writing files to from the container (i.e. input and output files). Depending on how you installed/run Docker, this folder might need full read/write permissions for other users (e.g. run `chmod 777`). 

The `docker_run.sh` command will then launch the container itself, including the necessary postgres database and the notebook interface. It will also create two virtual docker volumes (named `pgdata` and `osm_data`). These volumes are used to store external data, i.e. the database contents and the `openstreetmap-carto` external files, so that subsequent launches are faster than the initial one.

After running the `./docker_run.sh` command you will see a lot of text running by while the container sets itself up. At the end of this, you should see this: 

```
To access the server, open this file in a browser:
        file:///home/postgres/.local/share/jupyter/runtime/jpserver-1-open.html
    Or copy and paste one of these URLs:
        http://1ce38bef580f:8888/tree?token=asecrettokenwithlotsofcharacters
        http://127.0.0.1:8888/tree?token=asecrettokenwithlotsofcharacters
```

Clicking on the `http://127.0.0.1:8888/tree?…` link will open the notebook interface in your web-browser, where you can open the `make-images.ipynb` notebook, which will have all the necessary instructions to get started.

## Usage of `make.sh` without the container

If you have tile-building setup on your computer, you can run `make.sh` without Docker, following these steps:

1. Download an OSM history file (`.osh.pbf`) e.g. from [Geofabrik's internal download server](https://osm-internal.download.geofabrik.de/?landing_page=true). You will need to log in with an OSM account.
1. Calculate the `BBOX` with [BBoxFinder.com](http://bboxfinder.com/).
    1. *Draw a rectangle*
    1. Copy the *Box* value
    1. Make sure coordinates are in `long/lat` format (can be changed in the bottom-right)
1. Run the following command:
    ```bash
    ./make.sh OSM_HISTORY_FILE.osh.pbf BEFORE_TIME AFTER_TIME BBOX MIN_ZOOM MAX_ZOOM
    ```
    The `BEFORE_TIME` & `AFTER_TIME` are ISO 8601 timestamps.

## Example output

![Example](sample.png)

## Copyright & Licence

Copyright © 2021–2026, Affero GPL v3+ (see [LICENCE](./LICENCE)). Project is [`osm-mapping-party-before-after` on GitHub](https://github.com/iandees/osm-mapping-party-before-after)
