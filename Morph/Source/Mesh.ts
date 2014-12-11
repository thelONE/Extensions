/// <reference path="./EventSeries.ts"/>
/// <reference path="./ReferenceDeformation.ts"/>
/// <reference path="./ShapeKeyGroup.ts"/>
module MORPH {
    export class Mesh extends BABYLON.Mesh {
        public  debug = false;
        private _engine: BABYLON.Engine;
        private _positions32F : Float32Array;
        private _normals32F   : Float32Array;
        public  originalPositions: number[];
        private _shapeKeyGroups = new Array<ShapeKeyGroup>();
        
        // for normal processing
        private _vertexMemberOfFaces = new Array<Array<number>>(); // outer array each vertex, inner array faces vertex is a member of
        
        // for passive detection of game pause
        private _lastResumeTime = 0;
        private _instancePaused = false;

        // tracking system members
        private _clockStart = -1;
        private _renderCPU = 0;
        private _totalDeformations = 0;
        private _totalFrames = 0;
        
        // pov orientation
        private _definedFacingForward : boolean = true;

        constructor(name: string, scene: BABYLON.Scene) {
            super(name, scene);
            this._engine = scene.getEngine();    
            
            // tricky registering a prototype as a callback in constructor; cannot say 'this.beforeRender()' & must be wrappered
            var ref = this;
            this.registerBeforeRender(function(){ref.beforeRender();});
        }
        // ============================ beforeRender callback & tracking =============================
        public beforeRender() : void {
            if (this._positions32F === null || this._normals32F === null || Mesh._systemPaused || this._instancePaused) return;
            var startTime = Mesh.now();            

            // system resume test 
            if (this._lastResumeTime < Mesh._systemResumeTime){
                for (var g = this._shapeKeyGroups.length - 1; g >= 0; g--){
                    this._shapeKeyGroups[g].resumePlay();
                }
                this._lastResumeTime = Mesh._systemResumeTime;
            }

            var changesMade = false;
            for (var g = this._shapeKeyGroups.length - 1; g >= 0; g--){               
                // do NOT combine these 2 lines or only 1 group will run!
                var changed = this._shapeKeyGroups[g].incrementallyDeform(this._positions32F, this._normals32F);
                changesMade = changesMade || changed;
            }
            
            if (changesMade){            
                if (this._clockStart < 0) this._resetTracking(startTime); // delay tracking until the first change is made
                
                // resend positions & normals
                super.updateVerticesDataDirectly(BABYLON.VertexBuffer.PositionKind, this._positions32F);
                super.updateVerticesDataDirectly(BABYLON.VertexBuffer.NormalKind  , this._normals32F);
            
                this._renderCPU += Mesh.now() - startTime;
                this._totalDeformations++;  
            }
                
            this._totalFrames ++;
        }
        
        public resetTracking() : void{
            this._resetTracking(Mesh.now());
        }
        private _resetTracking(startTime : number) : void{
            this._clockStart = startTime;
            this._renderCPU = 0;
            this._totalDeformations = 0; 
            this._totalFrames = 0;           
        }
        
        public getTrackingReport(reset : boolean = false) : string{
            var totalWallClock = Mesh.now() - this._clockStart;
            var report =
                    "\nNum Deformations: " + this._totalDeformations +
                    "\nRender CPU milli: " + this._renderCPU.toFixed(2) +
                    "\nRender CPU milli / Deformations: " + (this._renderCPU / this._totalDeformations).toFixed(2) +
                    "\nWallclock milli / Deformations: " + (totalWallClock / this._totalDeformations).toFixed(2) +
                    "\nMemo, Deformations / Sec: " + (this._totalDeformations / (totalWallClock / 1000)).toFixed(2) +
                    "\nMemo, Frames with no deformation: " + (this._totalFrames - this._totalDeformations) +
                    "\nMemo, Total vertices: " + this.getTotalVertices() +
                    "\nShape keys:";
            for (var i = 0; i < this._shapeKeyGroups.length; i++)
                report += "\n" + this._shapeKeyGroups[i].toString();
            
            if (reset) this.resetTracking();
            return report;    
        }
        // ======================================== Overrides ========================================
        public clone(name: string, newParent: BABYLON.Node, doNotCloneChildren?: boolean): Mesh {
             BABYLON.Tools.Error("Shared vertex instances not supported for MORPH.Mesh");
            return null;
        }
        public createInstance(name: string): BABYLON.InstancedMesh {
             BABYLON.Tools.Error("Shared vertex instances not supported for MORPH.Mesh");
             return null;
        }
        public convertToFlatShadedMesh() : void {
            BABYLON.Tools.Error("Flat shading not supported for MORPH.Mesh");
        }
         
        /* wrappered is so positions & normals vertex buffer & initial data can be captured */
        public setVerticesData(kind: any, data: any, updatable?: boolean) : void {
            super.setVerticesData(kind, data, updatable || kind === BABYLON.VertexBuffer.PositionKind || kind === BABYLON.VertexBuffer.NormalKind);
            
            if (kind === BABYLON.VertexBuffer.PositionKind){
                this.originalPositions = data;
                this._positions32F = new Float32Array(data);
            }
            else if (kind === BABYLON.VertexBuffer.NormalKind){
                this._normals32F = new Float32Array(data);
            }
        }
        
        /** wrappered so this._vertexMemberOfFaces can be built after super.setIndices() called */
        public setIndices(indices: number[]): void {
            super.setIndices(indices);
            
            // now determine _vertexMemberOfFaces, to improve normals performance
            var nFaces = indices.length / 3;
            var faceOffset : number;
            
            // _vertexMemberOfFaces:  outer array each vertex, inner array faces vertex is a member of
            var nVertices = super.getTotalVertices();

            // possibly remove or comment out
            var nZeroAreaFaces = this.findZeroAreaFaces();
            if (nZeroAreaFaces > 0) BABYLON.Tools.Warn("MORPH.Mesh: Zero area faces found:  " + nZeroAreaFaces + ", nFaces: " + nFaces + ", nVert " + nVertices);
            
            for (var v = 0; v < nVertices; v++){
                var memberOf = new Array<number>();
                
                for (var f = 0; f < nFaces; f++){
                    faceOffset = f * 3;
                    if (indices[faceOffset] === v || indices[faceOffset + 1] === v ||indices[faceOffset + 2] === v){
                        memberOf.push(f);
                    }
                }
                this._vertexMemberOfFaces.push(memberOf);
            }       
        }
        /** bad things happen to normals when a face has no area.  Double check & put out warning in setIndices() if any found */
        private findZeroAreaFaces() : number {
            var indices = super.getIndices();
            var nFaces = indices.length / 3;
            var positions = super.getVerticesData(BABYLON.VertexBuffer.PositionKind);
            var nZeroAreaFaces = 0;
            var faceOffset : number;
            var p1 = BABYLON.Vector3.Zero();
            var p2 = BABYLON.Vector3.Zero();
            var p3 = BABYLON.Vector3.Zero();
    
            for (var f = 0; f < nFaces; f++){
                faceOffset = f * 3;
                BABYLON.Vector3.FromArrayToRef(positions, 3 * indices[faceOffset    ], p1);
                BABYLON.Vector3.FromArrayToRef(positions, 3 * indices[faceOffset + 1], p2);
                BABYLON.Vector3.FromArrayToRef(positions, 3 * indices[faceOffset + 2], p3);
                
                if (p1.equals(p2) || p1.equals(p3) || p2.equals(p3)) nZeroAreaFaces++
            }
            return nZeroAreaFaces;
        }
        // ==================================== Normals processing ===================================
        /**
         * based on http://stackoverflow.com/questions/18519586/calculate-normal-per-vertex-opengl 
         * @param {Uint16Array} vertices - the vertices which need the normals calculated, so do not have to do the entire mesh
         * @param {Float32Array} normals - the array to place the results, size:  vertices.length * 3
         * @param {Float32Array} futurePos - value of positions on which to base normals, passing since so does not have to be set to in mesh yet
         */
        public normalsforVerticesInPlace(vertices : Uint16Array, normals : Float32Array, futurePos : Float32Array) : void {
            var indices = super.getIndices();
            var nVertices = vertices.length;
            
            // Define all the reusable objects outside the for loop, so ..ToRef() & ..InPlace() versions can be used, 
            // avoiding many single use objects to garbage collect.
            var memberOfFaces : Array<number>;
            var nFaces : number;
            var faceOffset : number;
            var vertexID : number;
            var p1 = BABYLON.Vector3.Zero();
            var p2 = BABYLON.Vector3.Zero();
            var p3 = BABYLON.Vector3.Zero();
            var p1p2 = BABYLON.Vector3.Zero();
            var p3p2 = BABYLON.Vector3.Zero();

            var cross = BABYLON.Vector3.Zero();
            var normal = BABYLON.Vector3.Zero();
            var sinAlpha :number;
            var weightedAvgSum = BABYLON.Vector3.Zero();
            
            for (var v = 0; v < nVertices; v++){
                memberOfFaces = this._vertexMemberOfFaces[vertices[v]];
                nFaces = memberOfFaces.length;
                BABYLON.Vector3.FromFloatsToRef(0, 0, 0, weightedAvgSum); // initialize reused vector to all zeros
                
                for (var f = 0; f < nFaces; f++){
                    faceOffset = memberOfFaces[f] * 3;
                    vertexID = this.indexOfVertInFace(indices[faceOffset], indices[faceOffset + 1], indices[faceOffset + 2], vertices[v]);
                    if (vertexID === -1) throw "MORPH.Mesh: vertex not part of face";  // should not happen, but better to check
                    
                    // triangleNormalFromVertex() as from example noted above
                    BABYLON.Vector3.FromFloatArrayToRef(futurePos, 3 * indices[faceOffset +   vertexID], p1);
                    BABYLON.Vector3.FromFloatArrayToRef(futurePos, 3 * indices[faceOffset + ((vertexID + 1) % 3)], p2);
                    BABYLON.Vector3.FromFloatArrayToRef(futurePos, 3 * indices[faceOffset + ((vertexID + 2) % 3)], p3);
                        
                    p1.subtractToRef(p2, p1p2);
                    p3.subtractToRef(p2, p3p2);
                    
                    BABYLON.Vector3.CrossToRef(p1p2, p3p2, cross);
                    BABYLON.Vector3.NormalizeToRef(cross, normal);
                    
                    sinAlpha = cross.length() / (p1p2.length() * p3p2.length());
                    
                    // due floating point, might not be -1 ≤ sinAlpha ≤ 1, e.g. 1.0000000000000002; fix to avoid Math.asin() from returning NaN
                    if (sinAlpha < -1) sinAlpha = -1;
                    else if (sinAlpha > 1) sinAlpha = 1;
                    
                    normal.scaleInPlace(Math.asin(sinAlpha));                    
                    weightedAvgSum.addInPlace(normal);
                }
                weightedAvgSum.normalize();
                normals[ v * 3     ] = weightedAvgSum.x;
                normals[(v * 3) + 1] = weightedAvgSum.y;
                normals[(v * 3) + 2] = weightedAvgSum.z;
            }
        }

        private indexOfVertInFace(idx0 : number, idx1 : number, idx2 : number, vertIdx : number) : number{
            if (vertIdx === idx0) return 0;
            if (vertIdx === idx1) return 1;
            if (vertIdx === idx2) return 2;
            return -1;
        }
        // ================================== ShapeKeyGroup related ==================================
        public addShapeKeyGroup(shapeKeyGroup : ShapeKeyGroup) : void {
            this._shapeKeyGroups.push(shapeKeyGroup);
        }
            
        public queueSingleEvent(event : ReferenceDeformation) : void {
            this.queueEventSeries(new EventSeries([event]));
        }
        
        public queueEventSeries(eSeries : EventSeries) : void {
            var groupFound = false;  
            for (var g = this._shapeKeyGroups.length - 1; g >= 0; g--){
                if (eSeries.isShapeKeyGroupParticipating(this._shapeKeyGroups[g].getName())){
                    this._shapeKeyGroups[g].queueEventSeries(eSeries);
                    groupFound = true;
                }
            }
            if (this.debug && !groupFound) BABYLON.Tools.Warn("no shape keys groups participating in event series");
        }
        
        public getShapeKeyGroup(groupName : string) : ShapeKeyGroup {
            for (var g = this._shapeKeyGroups.length - 1; g >= 0; g--){
                if (this._shapeKeyGroups[g].getName() === groupName){
                    return this._shapeKeyGroups[g];
                }
            }
            return null;
        }
        // ================================== Point of View Movement =================================
        /**
         * When the mesh is defined facing forward, multipliers must be set so that movePOV() is 
         * from the point of view of behind the front of the mesh.
         * @param {boolean} definedFacingForward - True is the default
         */
        public setDefinedFacingForward(definedFacingForward : boolean) : void {
            this._definedFacingForward = definedFacingForward;
        }
        
        /**
         * Perform relative position change from the point of view of behind the front of the mesh.
         * This is performed taking into account the meshes current rotation, so you do not have to care.
         * Supports definition of mesh facing forward or backward.
         * @param {number} amountRight
         * @param {number} amountUp
         * @param {number} amountForward
         */
        public movePOV(amountRight : number, amountUp : number, amountForward : number) : void {
            this.position.addInPlace(this.calcMovePOV(amountRight, amountUp, amountForward));
        }
        
        /**
         * Calculate relative position change from the point of view of behind the front of the mesh.
         * This is performed taking into account the meshes current rotation, so you do not have to care.
         * Supports definition of mesh facing forward or backward.
         * @param {number} amountRight
         * @param {number} amountUp
         * @param {number} amountForward
         */
        public calcMovePOV(amountRight : number, amountUp : number, amountForward : number) : BABYLON.Vector3 {
            var rotMatrix = new BABYLON.Matrix();
            var rotQuaternion = (this.rotationQuaternion) ? this.rotationQuaternion : BABYLON.Quaternion.RotationYawPitchRoll(this.rotation.y, this.rotation.x, this.rotation.z);
            rotQuaternion.toRotationMatrix(rotMatrix);
            
            var translationDelta = BABYLON.Vector3.Zero();
            var defForwardMult = this._definedFacingForward ? -1 : 1;
            BABYLON.Vector3.TransformCoordinatesFromFloatsToRef(amountRight * defForwardMult, amountUp, amountForward * defForwardMult, rotMatrix, translationDelta);
            return translationDelta;
        }
        // ================================== Point of View Rotation =================================
        /**
         * Perform relative rotation change from the point of view of behind the front of the mesh.
         * Supports definition of mesh facing forward or backward.
         * @param {number} flipBack
         * @param {number} twirlClockwise
         * @param {number} tiltRight
         */
        public rotatePOV(flipBack : number, twirlClockwise : number, tiltRight : number) : void {
            this.rotation.addInPlace(this.calcRotatePOV(flipBack, twirlClockwise, tiltRight));
        }
        
        /**
         * Calculate relative rotation change from the point of view of behind the front of the mesh.
         * Supports definition of mesh facing forward or backward.
         * @param {number} flipBack
         * @param {number} twirlClockwise
         * @param {number} tiltRight
         */
        public calcRotatePOV(flipBack : number, twirlClockwise : number, tiltRight : number) : BABYLON.Vector3 {
            var defForwardMult = this._definedFacingForward ? 1 : -1;
            return new BABYLON.Vector3(flipBack * defForwardMult, twirlClockwise, tiltRight * defForwardMult);
        }
        // =================================== play - pause system ===================================
        // pause & resume statics
        private static _systemPaused = false;
        private static _systemResumeTime = 0;
        
        /** system could be paused at a higher up without notification; just by stop calling beforeRender() */
        public static pauseSystem(){ Mesh._systemPaused = true; }        
        public static isSystemPaused() : boolean { return Mesh._systemPaused; }
        
        public static resumeSystem(){
            Mesh._systemPaused = false;
            Mesh._systemResumeTime = Mesh.now();
        }
        
        // instance level methods
        public pausePlay(){ this._instancePaused = true; }       
        public isPaused() : boolean { return this._instancePaused; }
        
        public resumePlay(){
            this._instancePaused = false;
            this._lastResumeTime = Mesh.now();
            
            for (var g = this._shapeKeyGroups.length - 1; g >= 0; g--){
                this._shapeKeyGroups[g].resumePlay();
            }
        }
        // ========================================= Statics =========================================
        /** wrapper for window.performance.now, incase not implemented, e.g. Safari */
        public static now() : number{
            return (typeof window.performance === "undefined") ? Date.now() : window.performance.now();
        }
        
        public static get Version(): string {
            return "1.1.0";
        }
    }
}
