'use strict';

/**
 * Walkthrough tour data. Used by the browser (walkthrough.js) and by the sample
 * generator (tools/render-sample.js), so the model is defined in one place.
 *
 * Units are metres. x and z are the floor plan, y is up, the floor is y = 0.
 * Facing +z (down the hallway) your left is +x and your right is -x.
 *
 * To describe your own property:
 *   stops : the route, in walking order. One 360° photo per stop, the camera
 *           position it was taken from, and `heading`: the direction the visitor
 *           faces there (degrees, 90 = +z, 0 = +x, 180 = -x). Headings are
 *           unwrapped, so 90 -> 0 turns left and 90 -> 180 turns right. The same
 *           photo can be used for several stops (e.g. when you walk back out).
 *   rooms : boxes whose union is the walls of the space (max 12). Boxes must
 *           overlap a little where they join. A narrow door is a small box that
 *           bridges the two rooms.
 *   solids: furniture boxes the photos are projected onto too (max 32).
 *   video : optional walkthrough video (any normal video; scroll scrubs it).
 */

// The route. Photos are reused when the visitor passes the same spot again.
const stops = [
    { name: 'Entrance',                 photo: 'samples/flat-1-entrance.jpg',      pos: [0, 1.55, 0.9],   heading: 90 },
    { name: 'Hallway',                  photo: 'samples/flat-2-hall-bath.jpg',     pos: [0, 1.55, 2.4],   heading: 55 },
    { name: 'Bathroom',                 photo: 'samples/flat-3-bathroom.jpg',      pos: [2.1, 1.55, 2.4], heading: -45 },
    { name: 'Hallway',                  photo: 'samples/flat-2-hall-bath.jpg',     pos: [0, 1.55, 2.4],   heading: 90 },
    { name: 'Bedroom door',             photo: 'samples/flat-4-hall-bed.jpg',      pos: [0, 1.55, 5.0],   heading: 140 },
    { name: 'Bedroom',                  photo: 'samples/flat-5-bedroom.jpg',       pos: [-2.4, 1.55, 5.0], heading: 180 },
    { name: 'Bedroom door',             photo: 'samples/flat-4-hall-bed.jpg',      pos: [0, 1.55, 5.0],   heading: 90 },
    { name: 'Living room',              photo: 'samples/flat-6-living.jpg',        pos: [0, 1.55, 7.6],   heading: 90 },
    // Side rooms are reached through the living room, so every trip passes a living-room stop:
    // a photo taken inside a side room can't see the middle of the living room.
    { name: 'Kitchen',                  photo: 'samples/flat-8-kitchen.jpg',       pos: [4.4, 1.55, 8.0], heading: 0 },
    { name: 'Living room',              photo: 'samples/flat-6-living.jpg',        pos: [0, 1.55, 7.6],   heading: 150 },
    { name: 'Second bedroom',           photo: 'samples/flat-9-bedroom2.jpg',      pos: [-4.6, 1.55, 8.0], heading: 150 },
    { name: 'Living room',              photo: 'samples/flat-6-living.jpg',        pos: [0, 1.55, 7.6],   heading: 20 },
    { name: 'By the window',            photo: 'samples/flat-7-window.jpg',        pos: [0, 1.55, 10.6],  heading: 90 }
];

// Direction the visitor faces at progress s (0 = first stop, stops.length - 1 = last).
// Eases between the stop headings. The turn happens in the first ~70% of each leg, so
// the visitor is already facing the next stop (or doorway) before they get there.
function headingAt(s) {
    const last = stops.length - 1;
    const i = Math.min(Math.max(Math.floor(s), 0), last - 1);
    const f = Math.min(Math.max(s - i, 0), 1);
    const t = Math.min(Math.max((f - 0.1) / 0.6, 0), 1);
    const eased = t * t * (3 - 2 * t);
    return stops[i].heading + (stops[i + 1].heading - stops[i].heading) * eased;
}

// Where the camera is at progress s: straight legs between stops, equal time per leg.
function positionAt(s) {
    const last = stops.length - 1;
    const i = Math.min(Math.max(Math.floor(s), 0), last - 1);
    const f = Math.min(Math.max(s - i, 0), 1);
    const a = stops[i].pos;
    const b = stops[i + 1].pos;
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

// The camera of the sample video at progress s and video time `time` (seconds): the route
// position plus a little head bob and sway, so it reads as walking rather than gliding on
// rails. The renderer draws the video from this and the page projects markers from it, so
// they always agree.
function videoPose(s, time) {
    const pos = positionAt(s);
    const bob = Math.sin(time * Math.PI * 2 * 1.7) * 0.012;
    const sway = Math.sin(time * Math.PI * 2 * 0.85) * 0.006;
    const yaw = (headingAt(s) * Math.PI) / 180 + Math.sin(time * 0.9) * 0.025;
    return {
        pos: [pos[0] + sway, pos[1] + bob, pos[2]],
        forward: [Math.cos(yaw), -0.02 + Math.sin(time * Math.PI * 2 * 1.7 + 1) * 0.004, Math.sin(yaw)]
    };
}

const SampleTour = {
    name: 'Sample flat',

    // Walls = union of these boxes. The two "door" boxes are 0.9 m wide openings
    // bridging the hallway and the side rooms through the wall.
    rooms: [
        { name: 'Hallway',       min: [-0.8, 0, 0],      max: [0.8, 2.6, 7.0] },
        { name: 'Living room',   min: [-2.8, 0, 6.99],   max: [2.8, 2.6, 12.5] },
        { name: 'Bedroom',       min: [-4.8, 0, 3.0],    max: [-0.95, 2.6, 6.5] },      // right of the hallway
        { name: 'Bathroom',      min: [0.95, 0, 1.2],    max: [3.3, 2.6, 4.0] },        // left of the hallway
        { name: 'Bedroom door',  min: [-1.0, 0, 4.55],   max: [-0.75, 2.05, 5.45] },
        { name: 'Bathroom door', min: [0.75, 0, 1.95],   max: [1.0, 2.05, 2.85] },
        // Off the living room: an open kitchen on the left, a second bedroom on the right
        { name: 'Kitchen',       min: [2.95, 0, 5.2],    max: [6.3, 2.6, 9.0] },
        { name: 'Kitchen door',  min: [2.7, 0, 7.4],     max: [3.05, 2.2, 8.6] },        // wide opening
        { name: 'Bedroom 2',     min: [-6.4, 0, 6.8],    max: [-3.05, 2.6, 10.8] },
        { name: 'Bedroom 2 door', min: [-3.15, 0, 7.4],  max: [-2.7, 2.05, 8.3] }
    ],

    solids: [
        { name: 'shoe cabinet',  min: [-0.8, 0, 1.6],     max: [-0.42, 0.95, 3.0] },
        // Living room
        { name: 'sofa seat',     min: [-2.7, 0, 8.6],     max: [-1.2, 0.45, 11.2] },
        { name: 'sofa back',     min: [-2.7, 0.45, 8.6],  max: [-2.4, 0.95, 11.2] },
        { name: 'ottoman',       min: [-1.0, 0, 8.9],     max: [-0.3, 0.42, 10.0] },
        { name: 'tv unit',       min: [2.35, 0, 8.8],     max: [2.8, 0.5, 10.8] },
        { name: 'tv',            min: [2.7, 1.0, 9.2],    max: [2.8, 1.75, 10.4] },
        // Bedroom
        { name: 'bed',           min: [-4.7, 0, 4.2],     max: [-3.0, 0.5, 5.8] },
        { name: 'headboard',     min: [-4.8, 0.5, 4.0],   max: [-4.65, 1.2, 6.0] },
        { name: 'nightstand',    min: [-4.7, 0, 3.55],    max: [-4.25, 0.5, 4.0] },
        { name: 'nightstand',    min: [-4.7, 0, 6.0],     max: [-4.25, 0.5, 6.45] },
        { name: 'wardrobe',      min: [-3.9, 0, 5.9],     max: [-1.7, 2.2, 6.5] },
        // Bathroom
        { name: 'bathtub',       min: [1.4, 0, 1.2],      max: [3.3, 0.55, 1.9] },
        { name: 'toilet bowl',   min: [2.75, 0, 2.65],    max: [3.3, 0.4, 3.15] },
        { name: 'toilet tank',   min: [3.1, 0.4, 2.65],   max: [3.3, 0.85, 3.15] },
        { name: 'vanity',        min: [1.5, 0, 3.5],      max: [2.5, 0.85, 4.0] },
        // Kitchen
        { name: 'kitchen base',  min: [5.7, 0, 5.4],      max: [6.3, 0.9, 8.1] },
        { name: 'kitchen upper', min: [6.0, 1.5, 5.4],    max: [6.3, 2.2, 8.1] },
        { name: 'fridge',        min: [5.6, 0, 8.2],      max: [6.3, 1.85, 8.95] },
        { name: 'island',        min: [3.7, 0, 5.7],      max: [4.6, 0.92, 7.0] },
        { name: 'stool',         min: [3.85, 0, 7.15],    max: [4.15, 0.62, 7.45] },
        { name: 'stool',         min: [4.25, 0, 7.15],    max: [4.55, 0.62, 7.45] },
        // Second bedroom
        { name: 'bed 2',         min: [-6.3, 0, 8.6],     max: [-4.3, 0.45, 9.8] },
        { name: 'headboard 2',   min: [-6.4, 0.45, 8.5],  max: [-6.25, 1.1, 9.9] },
        { name: 'wardrobe 2',    min: [-5.6, 0, 6.8],     max: [-3.4, 2.2, 7.4] },
        { name: 'desk',          min: [-5.6, 0, 10.1],    max: [-4.2, 0.75, 10.8] }
    ],

    stops,
    headingAt,
    positionAt,
    videoPose,

    // Forward glide: each photo is seen on a sphere of this radius around its stop
    glideRadius: 3.5,

    // Walking video. It passes the stops at equal time intervals, which is what
    // lets one scroll position drive the photos and the video alike.
    video: { src: 'samples/walkthrough.mp4', width: 960, height: 540, fps: 24, seconds: 22, fov: 72 }
};

if (typeof module !== 'undefined' && module.exports) module.exports = SampleTour;
else window.SampleTour = SampleTour;
